import { randomUUID } from 'node:crypto';
import { Prisma, type Charge, type ChargeStatus, type ChargeType, type Loan, type Merchant } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { D, ZERO } from '../lib/money';
import { toMpDate, todayDbDate as todaySaoPaulo } from '../lib/dates';
import { mpRequest, MercadoPagoError } from './mercadopago/http';
import { getMerchantAccessToken, OAuthFlowError } from './mercadopago/oauth.service';
import type { MpPixPaymentResponse, MpPreferenceResponse } from './mercadopago/types';

// ---------------------------------------------------------------------------
// Erros e DTO
// ---------------------------------------------------------------------------
export class ChargeError extends Error {
  constructor(public readonly code: string, public readonly httpStatus: number, message: string) {
    super(message);
    this.name = 'ChargeError';
  }
}

export interface ChargeDto {
  id: string;
  type: ChargeType;
  status: ChargeStatus;
  grossAmount: string;
  feeAmount: string;
  qrCode: string | null;
  qrCodeBase64: string | null;
  paymentUrl: string | null;
  expiresAt: Date | null;
  whatsappUrl?: string;
  replayed?: boolean;
}

export function toChargeDto(c: Charge, extra: Partial<ChargeDto> = {}): ChargeDto {
  return {
    id: c.id,
    type: c.type,
    status: c.status,
    grossAmount: c.grossAmount.toFixed(2),
    feeAmount: c.feeAmount.toFixed(2),
    qrCode: c.qrCode,
    qrCodeBase64: c.qrCodeBase64,
    paymentUrl: c.paymentUrl,
    expiresAt: c.expiresAt,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

export { toMpDate };

const MP_STATUS: Record<string, ChargeStatus> = {
  pending: 'PENDING',
  in_process: 'PENDING',
  approved: 'APPROVED',
  rejected: 'REJECTED',
  cancelled: 'CANCELLED',
};

/**
 * Idempotência ponta a ponta:
 *  - o frontend manda o header Idempotency-Key (um UUID por clique em "Gerar");
 *  - se o operador clicar duas vezes ou a rede repetir, devolvemos a MESMA cobrança;
 *  - para o MP usamos o id da Charge como X-Idempotency-Key, então uma
 *    nova tentativa após timeout não cria um segundo Pix.
 */
async function findReplay(type: ChargeType, clientKey: string, merchantId: string): Promise<Charge | null> {
  const existing = await prisma.charge.findUnique({ where: { idempotencyKey: `${type}:${clientKey}` } });
  if (!existing) return null;
  if (existing.merchantId !== merchantId) {
    throw new ChargeError('idempotency_conflict', 422, 'Idempotency-Key já usada em outra cobrança');
  }
  return existing;
}

async function loadMerchantWithActiveLoan(merchantId: string): Promise<{ merchant: Merchant; loan: Loan }> {
  const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } });
  if (!merchant) throw new ChargeError('merchant_not_found', 404, 'Comerciante não encontrado');
  if (merchant.status !== 'ACTIVE') {
    throw new ChargeError('merchant_not_active', 409, `Comerciante com status ${merchant.status}`);
  }
  const loan = await prisma.loan.findFirst({
    where: { merchantId, status: 'ACTIVE' },
    orderBy: { createdAt: 'desc' },
  });
  if (!loan) throw new ChargeError('no_active_loan', 409, 'Comerciante sem contrato ativo');
  return { merchant, loan };
}

/**
 * Comissão (split) de uma venda: % do contrato sobre o valor bruto,
 * arredondada para baixo e limitada ao saldo devedor.
 */
export function computeSplitFee(gross: Prisma.Decimal, loan: Loan): Prisma.Decimal {
  const pct = loan.splitPercent;
  if (pct.lessThanOrEqualTo(0) || pct.greaterThanOrEqualTo(100)) {
    throw new ChargeError('invalid_split_percent', 500, 'Percentual de split inválido no contrato');
  }
  const fee = gross.mul(pct).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
  return Prisma.Decimal.min(fee, loan.outstandingBalance);
}

async function markFailed(chargeId: string, err: unknown) {
  const body = err instanceof MercadoPagoError ? err.body : { message: String(err) };
  await prisma.charge.update({
    where: { id: chargeId },
    data: { status: 'CANCELLED', rawResponse: { error: body } as Prisma.InputJsonValue },
  });
}

function mpFailure(err: unknown): ChargeError {
  if (err instanceof MercadoPagoError) {
    const b = err.body as { message?: string } | null;
    return new ChargeError('mercadopago_error', 502, b?.message ?? `Mercado Pago respondeu ${err.status}`);
  }
  if (err instanceof OAuthFlowError) return new ChargeError(err.code, 409, err.message);
  return new ChargeError('internal_error', 500, 'Erro ao criar cobrança');
}

/** Remove o PNG base64 do JSON bruto guardado (ele já fica em qrCodeBase64). */
function slimRaw(p: MpPixPaymentResponse): Prisma.InputJsonValue {
  const clone = structuredClone(p);
  if (clone.point_of_interaction?.transaction_data) {
    delete clone.point_of_interaction.transaction_data.qr_code_base64;
  }
  return clone as unknown as Prisma.InputJsonValue;
}

/**
 * Grava o retorno do MP SEM rebaixar status: o webhook pode ter chegado
 * antes desta resposta e já marcado a cobrança como APPROVED.
 */
async function applyCreationResult(
  chargeId: string,
  fields: Prisma.ChargeUpdateInput,
  initialStatus: ChargeStatus,
): Promise<Charge> {
  await prisma.charge.update({ where: { id: chargeId }, data: fields });
  await prisma.charge.updateMany({ where: { id: chargeId, status: 'CREATED' }, data: { status: initialStatus } });
  return prisma.charge.findUniqueOrThrow({ where: { id: chargeId } });
}

// ---------------------------------------------------------------------------
// 1) PIX DE BALCÃO — /v1/payments na conta do comerciante com application_fee
// ---------------------------------------------------------------------------
export interface PixBalcaoInput {
  merchantId: string;
  amount: number;
  description?: string;
  payerEmail?: string;
  payerCpf?: string;
  idempotencyKey: string;
  operatorId: string;
}

export async function createPixBalcao(input: PixBalcaoInput): Promise<ChargeDto> {
  const replay = await findReplay('PIX_BALCAO', input.idempotencyKey, input.merchantId);
  if (replay) return toChargeDto(replay, { replayed: true });

  const { merchant, loan } = await loadMerchantWithActiveLoan(input.merchantId);
  const gross = D(input.amount).toDecimalPlaces(2);
  const fee = computeSplitFee(gross, loan);
  const expiresAt = new Date(Date.now() + env.PIX_BALCAO_EXPIRATION_MINUTES * 60_000);

  const charge = await prisma.charge.create({
    data: {
      merchantId: merchant.id,
      loanId: loan.id,
      type: 'PIX_BALCAO',
      grossAmount: gross,
      feeAmount: fee,
      idempotencyKey: `PIX_BALCAO:${input.idempotencyKey}`,
      externalRef: `chg_${randomUUID()}`,
      expiresAt,
    },
  });

  try {
    const token = await getMerchantAccessToken(merchant.id);
    const payment = await mpRequest<MpPixPaymentResponse>('/v1/payments', {
      method: 'POST',
      token,
      idempotencyKey: charge.id,
      body: {
        transaction_amount: Number(gross.toFixed(2)),
        description: (input.description ?? `Venda ${merchant.tradeName ?? merchant.legalName}`).slice(0, 250),
        payment_method_id: 'pix',
        external_reference: charge.externalRef,
        date_of_expiration: toMpDate(expiresAt),
        ...(fee.greaterThan(0) ? { application_fee: Number(fee.toFixed(2)) } : {}),
        payer: {
          email: input.payerEmail ?? env.PIX_DEFAULT_PAYER_EMAIL,
          ...(input.payerCpf ? { identification: { type: 'CPF', number: input.payerCpf } } : {}),
        },
      },
    });

    const td = payment.point_of_interaction?.transaction_data;
    if (!td?.qr_code || !td.qr_code_base64) {
      throw new ChargeError('qr_missing', 502, 'Mercado Pago não retornou o QR Code');
    }

    const updated = await applyCreationResult(
      charge.id,
      {
        mpPaymentId: BigInt(payment.id),
        qrCode: td.qr_code,
        qrCodeBase64: td.qr_code_base64,
        paymentUrl: td.ticket_url ?? null,
        rawResponse: slimRaw(payment),
      },
      MP_STATUS[payment.status] ?? 'PENDING',
    );
    await audit(input.operatorId, 'charge.pix_balcao_created', updated);
    return toChargeDto(updated);
  } catch (err) {
    await markFailed(charge.id, err);
    throw err instanceof ChargeError ? err : mpFailure(err);
  }
}

// ---------------------------------------------------------------------------
// 2) LINK DE PAGAMENTO — preferência Checkout Pro com marketplace_fee
// ---------------------------------------------------------------------------
export interface PaymentLinkInput {
  merchantId: string;
  amount: number;
  title: string;
  payerEmail?: string;
  expiresInHours?: number;
  idempotencyKey: string;
  operatorId: string;
}

export async function createPaymentLink(input: PaymentLinkInput): Promise<ChargeDto> {
  const replay = await findReplay('PAYMENT_LINK', input.idempotencyKey, input.merchantId);
  if (replay) return toChargeDto(replay, { replayed: true });

  const { merchant, loan } = await loadMerchantWithActiveLoan(input.merchantId);
  const gross = D(input.amount).toDecimalPlaces(2);
  const fee = computeSplitFee(gross, loan);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (input.expiresInHours ?? env.LINK_EXPIRATION_HOURS) * 3600_000);

  const charge = await prisma.charge.create({
    data: {
      merchantId: merchant.id,
      loanId: loan.id,
      type: 'PAYMENT_LINK',
      grossAmount: gross,
      feeAmount: fee,
      idempotencyKey: `PAYMENT_LINK:${input.idempotencyKey}`,
      externalRef: `chg_${randomUUID()}`,
      expiresAt,
    },
  });

  try {
    const token = await getMerchantAccessToken(merchant.id);
    const pref = await mpRequest<MpPreferenceResponse>('/checkout/preferences', {
      method: 'POST',
      token,
      idempotencyKey: charge.id,
      body: {
        items: [{
          id: charge.id,
          title: input.title.slice(0, 250),
          quantity: 1,
          currency_id: 'BRL',
          unit_price: Number(gross.toFixed(2)),
        }],
        ...(fee.greaterThan(0) ? { marketplace_fee: Number(fee.toFixed(2)) } : {}),
        external_reference: charge.externalRef,
        expires: true,
        expiration_date_from: toMpDate(now),
        expiration_date_to: toMpDate(expiresAt),
        statement_descriptor: (merchant.tradeName ?? merchant.legalName).slice(0, 22),
        ...(input.payerEmail ? { payer: { email: input.payerEmail } } : {}),
      },
    });

    const updated = await applyCreationResult(
      charge.id,
      {
        mpPreferenceId: pref.id,
        paymentUrl: pref.init_point,
        rawResponse: pref as unknown as Prisma.InputJsonValue,
      },
      'PENDING',
    );
    await audit(input.operatorId, 'charge.payment_link_created', updated);
    return toChargeDto(updated);
  } catch (err) {
    await markFailed(charge.id, err);
    throw err instanceof ChargeError ? err : mpFailure(err);
  }
}

// ---------------------------------------------------------------------------
// 3) COBRANÇA AVULSA — Pix na CONTA MATRIZ (sem split), p/ atraso ou desvio
// ---------------------------------------------------------------------------
export interface AvulsaInput {
  merchantId: string;
  amount?: number; // se omitido: soma das parcelas vencidas + a de hoje
  reason: 'LOW_VOLUME' | 'OVERDUE' | 'CONTRACT_BREACH' | 'MANUAL';
  idempotencyKey: string;
  operatorId?: string; // ausente = gerada pelo sistema (auditoria diária)
}

export async function createAvulsa(input: AvulsaInput): Promise<ChargeDto> {
  const replay = await findReplay('AVULSA', input.idempotencyKey, input.merchantId);
  if (replay) {
    const [m, l] = await Promise.all([
      prisma.merchant.findUnique({ where: { id: replay.merchantId } }),
      replay.loanId ? prisma.loan.findUnique({ where: { id: replay.loanId } }) : null,
    ]);
    return toChargeDto(replay, { replayed: true, whatsappUrl: buildWhatsappUrl(replay, m ?? undefined, l ?? undefined) });
  }

  const merchant = await prisma.merchant.findUnique({ where: { id: input.merchantId } });
  if (!merchant) throw new ChargeError('merchant_not_found', 404, 'Comerciante não encontrado');

  // Avulsa funciona mesmo com OAuth revogado e com contrato em vencimento antecipado.
  const loan = await prisma.loan.findFirst({
    where: { merchantId: merchant.id, status: { in: ['ACTIVE', 'ACCELERATED'] } },
    orderBy: { createdAt: 'desc' },
  });
  if (!loan) throw new ChargeError('no_open_loan', 409, 'Comerciante sem contrato em aberto');

  let gross: Prisma.Decimal;
  if (input.amount != null) {
    gross = D(input.amount).toDecimalPlaces(2);
  } else if (loan.status === 'ACCELERATED') {
    gross = loan.outstandingBalance; // vencimento antecipado: saldo total
  } else {
    const open = await prisma.installment.findMany({
      where: { loanId: loan.id, dueDate: { lte: todaySaoPaulo() }, status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] } },
      select: { amountDue: true, amountPaid: true },
    });
    gross = open.reduce((acc, i) => acc.plus(i.amountDue.minus(i.amountPaid)), ZERO);
  }
  if (gross.lessThanOrEqualTo(0)) throw new ChargeError('nothing_due', 409, 'Não há valor em aberto para cobrar');
  if (gross.greaterThan(loan.outstandingBalance)) gross = loan.outstandingBalance;

  const expiresAt = new Date(Date.now() + env.AVULSA_EXPIRATION_HOURS * 3600_000);
  const charge = await prisma.charge.create({
    data: {
      merchantId: merchant.id,
      loanId: loan.id,
      type: 'AVULSA',
      grossAmount: gross,
      feeAmount: ZERO,
      idempotencyKey: `AVULSA:${input.idempotencyKey}`,
      externalRef: `chg_${randomUUID()}`,
      expiresAt,
    },
  });

  try {
    const payment = await mpRequest<MpPixPaymentResponse>('/v1/payments', {
      method: 'POST',
      token: env.MP_PLATFORM_ACCESS_TOKEN, // recebedor = conta matriz
      idempotencyKey: charge.id,
      body: {
        transaction_amount: Number(gross.toFixed(2)),
        description: `Parcela(s) contrato ${loan.contractNumber}`,
        payment_method_id: 'pix',
        external_reference: charge.externalRef,
        date_of_expiration: toMpDate(expiresAt),
        payer: {
          email: merchant.email ?? env.PIX_DEFAULT_PAYER_EMAIL,
          first_name: merchant.ownerName.split(' ')[0],
          identification: merchant.document.length === 14
            ? { type: 'CNPJ', number: merchant.document }
            : { type: 'CPF', number: merchant.document },
        },
      },
    });

    const td = payment.point_of_interaction?.transaction_data;
    if (!td?.qr_code) throw new ChargeError('qr_missing', 502, 'Mercado Pago não retornou o QR Code');

    const updated = await applyCreationResult(
      charge.id,
      {
        mpPaymentId: BigInt(payment.id),
        qrCode: td.qr_code,
        qrCodeBase64: td.qr_code_base64 ?? null,
        paymentUrl: td.ticket_url ?? null,
        rawResponse: slimRaw(payment),
      },
      MP_STATUS[payment.status] ?? 'PENDING',
    );
    await audit(input.operatorId, 'charge.avulsa_created', updated, { reason: input.reason });
    return toChargeDto(updated, { whatsappUrl: buildWhatsappUrl(updated, merchant, loan) });
  } catch (err) {
    await markFailed(charge.id, err);
    throw err instanceof ChargeError ? err : mpFailure(err);
  }
}

/**
 * Link wa.me com a mensagem pronta. O operador clica e envia.
 * (O envio 100% automático pela WhatsApp Cloud API entra na etapa de alertas.)
 */
function buildWhatsappUrl(c: Charge, merchant?: Merchant, loan?: Loan): string | undefined {
  if (!merchant || !c.qrCode) return undefined;
  const valor = Number(c.grossAmount).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const venc = c.expiresAt?.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
  const text = [
    `Olá, ${merchant.ownerName.split(' ')[0]}!`,
    `Segue a cobrança referente ao contrato ${loan?.contractNumber ?? ''}, no valor de ${valor}.`,
    venc ? `Válida até ${venc}.` : '',
    c.paymentUrl ? `Pagar pelo link: ${c.paymentUrl}` : '',
    '',
    'Pix copia e cola:',
    c.qrCode,
  ].filter((l) => l !== undefined).join('\n');
  return `https://wa.me/${merchant.whatsapp.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
}

async function audit(operatorId: string | undefined, action: string, c: Charge, extra: Record<string, unknown> = {}) {
  await prisma.auditLog.create({
    data: {
      operatorId: operatorId ?? null,
      actor: operatorId ? `operator:${operatorId}` : 'system:cron-audit',
      action,
      entity: 'Charge',
      entityId: c.id,
      after: {
        merchantId: c.merchantId,
        loanId: c.loanId,
        gross: c.grossAmount.toString(),
        fee: c.feeAmount.toString(),
        mpPaymentId: c.mpPaymentId?.toString() ?? null,
        mpPreferenceId: c.mpPreferenceId,
        ...extra,
      } as Prisma.InputJsonValue,
    },
  });
}
