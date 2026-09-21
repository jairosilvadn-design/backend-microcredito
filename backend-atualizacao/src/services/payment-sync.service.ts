import { ChargeStatus, Prisma } from '@prisma/client';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { D, ZERO, minDec } from '../lib/money';
import { mpRequest } from './mercadopago/http';
import { getMerchantAccessToken } from './mercadopago/oauth.service';
import type { MpPayment } from './mercadopago/types';
import { isSale } from './audit/payment-classifier';

type Tx = Prisma.TransactionClient;

const STATUS_MAP: Record<string, ChargeStatus> = {
  pending: 'PENDING',
  in_process: 'PENDING',
  authorized: 'PENDING',
  approved: 'APPROVED',
  rejected: 'REJECTED',
  cancelled: 'CANCELLED',
  refunded: 'REFUNDED',
  charged_back: 'REFUNDED',
};


/** Processa um evento de webhook "payment" já persistido em WebhookEvent. */
export async function processPaymentWebhook(eventId: string): Promise<void> {
  const event = await prisma.webhookEvent.findUniqueOrThrow({ where: { eventId } });
  if (event.processedAt) return;

  try {
    const payload = event.payload as { user_id?: number | string };
    const collectorUserId = payload.user_id != null ? BigInt(payload.user_id) : null;

    // 1) Descobre qual token usar para ler o pagamento
    let token: string;
    let merchantIdFromCollector: string | null = null;

    if (collectorUserId === env.MP_PLATFORM_USER_ID) {
      token = env.MP_PLATFORM_ACCESS_TOKEN; // cobrança avulsa recebida na conta matriz
    } else {
      const merchant = collectorUserId
        ? await prisma.merchant.findUnique({ where: { mpUserId: collectorUserId } })
        : null;
      if (!merchant) throw new Error(`Recebedor desconhecido: user_id=${String(collectorUserId)}`);
      merchantIdFromCollector = merchant.id;
      token = await getMerchantAccessToken(merchant.id);
    }

    // 2) Nunca confie no corpo do webhook: busca o estado real na API
    const payment = await mpRequest<MpPayment>(`/v1/payments/${event.resourceId}`, { token });

    const charge = await prisma.charge.findFirst({
      where: {
        OR: [
          { mpPaymentId: BigInt(payment.id) },
          ...(payment.external_reference ? [{ externalRef: payment.external_reference }] : []),
        ],
      },
    });

    // 3) Espelha no extrato local se for pagamento da conta do comerciante
    const merchantId = merchantIdFromCollector ?? charge?.merchantId ?? null;
    if (merchantIdFromCollector) {
      await upsertMpPayment(merchantIdFromCollector, payment, Boolean(charge), collectorUserId);
    }

    // 4) Aplica transição de status na cobrança e amortiza parcelas
    if (charge) {
      await applyChargeTransition(charge.id, payment);
    } else if (merchantId) {
      // Pagamento na conta do comerciante que NÃO foi gerado por nós.
      // Não alertamos aqui: a auditoria diária (Etapa 4) é quem decide o status.
    }

    await prisma.webhookEvent.update({ where: { eventId }, data: { processedAt: new Date(), error: null } });
  } catch (err) {
    await prisma.webhookEvent.update({
      where: { eventId },
      data: { error: String(err).slice(0, 2000) },
    });
    throw err;
  }
}

export async function upsertMpPayment(
  merchantId: string,
  p: MpPayment,
  viaSplit: boolean,
  merchantMpUserId?: bigint | null,
) {
  const appFee = p.fee_details?.find((f) => f.type === 'application_fee')?.amount;
  const data = {
    merchantId,
    status: p.status,
    statusDetail: p.status_detail ?? null,
    operationType: p.operation_type ?? null,
    paymentMethodId: p.payment_method_id ?? null,
    paymentTypeId: p.payment_type_id ?? null,
    pointOfInteraction: p.point_of_interaction?.type ?? null,
    transactionAmount: D(p.transaction_amount),
    netReceivedAmount: p.transaction_details?.net_received_amount != null
      ? D(p.transaction_details.net_received_amount) : null,
    applicationFee: appFee != null ? D(appFee) : null,
    viaSplit,
    countsAsSale: isSale(p, merchantMpUserId),
    dateApproved: p.date_approved ? new Date(p.date_approved) : null,
    dateCreated: new Date(p.date_created),
    raw: p as unknown as Prisma.InputJsonValue,
    syncedAt: new Date(),
  };
  await prisma.mpPayment.upsert({
    where: { mpPaymentId: BigInt(p.id) },
    create: { mpPaymentId: BigInt(p.id), ...data },
    update: data,
  });
}

/**
 * Transição idempotente: o webhook pode chegar 2x, fora de ordem, ou
 * junto com outro webhook do mesmo contrato. Por isso:
 *  - updateMany condicional garante que só UMA execução "vence" a transição;
 *  - SELECT ... FOR UPDATE no Loan serializa amortizações do mesmo contrato.
 */
async function applyChargeTransition(chargeId: string, p: MpPayment) {
  const newStatus = STATUS_MAP[p.status];
  if (!newStatus) return;

  const mpFee = p.fee_details?.find((f) => f.type === 'application_fee')?.amount;

  await prisma.$transaction(async (tx) => {
    const charge = await tx.charge.findUniqueOrThrow({ where: { id: chargeId } });

    if (newStatus === 'APPROVED') {
      const won = await tx.charge.updateMany({
        where: { id: chargeId, status: { notIn: ['APPROVED', 'REFUNDED'] } },
        data: {
          status: 'APPROVED',
          approvedAt: p.date_approved ? new Date(p.date_approved) : new Date(),
          mpPaymentId: BigInt(p.id),
        },
      });
      if (won.count !== 1 || !charge.loanId) return;

      // Valor que efetivamente amortiza:
      //  - AVULSA: pago direto na conta matriz -> valor bruto
      //  - Split: a comissão efetivamente retida pelo MP (fallback: valor esperado)
      const amount = charge.type === 'AVULSA'
        ? charge.grossAmount
        : mpFee != null ? D(mpFee) : charge.feeAmount;

      if (charge.type !== 'AVULSA' && mpFee != null && !D(mpFee).equals(charge.feeAmount)) {
        await tx.auditLog.create({
          data: {
            actor: 'system:webhook',
            action: 'charge.fee_mismatch',
            entity: 'Charge',
            entityId: chargeId,
            before: { expected: charge.feeAmount.toString() },
            after: { received: String(mpFee) },
          },
        });
      }

      await allocateToInstallments(tx, charge.loanId, chargeId, amount);
      return;
    }

    if (newStatus === 'REFUNDED') {
      const won = await tx.charge.updateMany({
        where: { id: chargeId, status: 'APPROVED' },
        data: { status: 'REFUNDED' },
      });
      if (won.count === 1 && charge.loanId) await reverseAllocations(tx, charge.loanId, chargeId);
      else await tx.charge.updateMany({ where: { id: chargeId, status: { notIn: ['APPROVED', 'REFUNDED'] } }, data: { status: 'REFUNDED' } });
      return;
    }

    // PENDING / REJECTED / CANCELLED: nunca rebaixa uma cobrança já aprovada ou estornada
    await tx.charge.updateMany({
      where: { id: chargeId, status: { notIn: ['APPROVED', 'REFUNDED'] } },
      data: { status: newStatus, mpPaymentId: BigInt(p.id) },
    });
  }, { timeout: 20_000 });
}

async function lockLoan(tx: Tx, loanId: string) {
  await tx.$queryRaw`SELECT id FROM "Loan" WHERE id = ${loanId}::uuid FOR UPDATE`;
}

/** Amortiza da parcela mais antiga em aberto para a mais nova. */
async function allocateToInstallments(tx: Tx, loanId: string, chargeId: string, amount: Prisma.Decimal) {
  await lockLoan(tx, loanId);

  const open = await tx.installment.findMany({
    where: { loanId, status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] } },
    orderBy: { dueDate: 'asc' },
  });

  let remaining = amount;
  let allocated = ZERO;

  for (const inst of open) {
    if (remaining.lessThanOrEqualTo(0)) break;
    const due = inst.amountDue.minus(inst.amountPaid);
    if (due.lessThanOrEqualTo(0)) continue;

    const take = minDec(due, remaining);
    const newPaid = inst.amountPaid.plus(take);
    const fullyPaid = newPaid.greaterThanOrEqualTo(inst.amountDue);

    await tx.chargeAllocation.create({ data: { chargeId, installmentId: inst.id, amount: take } });
    await tx.installment.update({
      where: { id: inst.id },
      data: {
        amountPaid: newPaid,
        status: fullyPaid ? 'PAID' : 'PARTIAL',
        paidAt: fullyPaid ? new Date() : null,
      },
    });
    remaining = remaining.minus(take);
    allocated = allocated.plus(take);
  }

  const loan = await tx.loan.findUniqueOrThrow({ where: { id: loanId } });
  const outstanding = loan.outstandingBalance.minus(allocated);
  await tx.loan.update({
    where: { id: loanId },
    data: {
      outstandingBalance: outstanding.lessThan(0) ? ZERO : outstanding,
      status: outstanding.lessThanOrEqualTo(0) && loan.status === 'ACTIVE' ? 'PAID' : loan.status,
    },
  });

  await tx.auditLog.create({
    data: {
      actor: 'system:webhook',
      action: 'loan.amortized',
      entity: 'Loan',
      entityId: loanId,
      after: { chargeId, allocated: allocated.toString(), surplus: remaining.toString() },
    },
  });
}

/** Estorno/chargeback: desfaz a amortização daquela cobrança. */
async function reverseAllocations(tx: Tx, loanId: string, chargeId: string) {
  await lockLoan(tx, loanId);

  const allocs = await tx.chargeAllocation.findMany({ where: { chargeId }, include: { installment: true } });
  const today = new Date(new Date().toISOString().slice(0, 10));
  let total = ZERO;

  for (const a of allocs) {
    const newPaid = a.installment.amountPaid.minus(a.amount);
    const status = newPaid.lessThanOrEqualTo(0)
      ? (a.installment.dueDate < today ? 'OVERDUE' : 'PENDING')
      : 'PARTIAL';
    await tx.installment.update({
      where: { id: a.installmentId },
      data: { amountPaid: newPaid.lessThan(0) ? ZERO : newPaid, status, paidAt: null },
    });
    total = total.plus(a.amount);
  }
  await tx.chargeAllocation.deleteMany({ where: { chargeId } });

  const loan = await tx.loan.findUniqueOrThrow({ where: { id: loanId } });
  await tx.loan.update({
    where: { id: loanId },
    data: {
      outstandingBalance: loan.outstandingBalance.plus(total),
      status: loan.status === 'PAID' ? 'ACTIVE' : loan.status,
    },
  });
  await tx.auditLog.create({
    data: {
      actor: 'system:webhook',
      action: 'loan.amortization_reversed',
      entity: 'Loan',
      entityId: loanId,
      before: { allocations: allocs.map((a) => ({ installmentId: a.installmentId, amount: a.amount.toString() })) },
      after: { chargeId, reversed: total.toString() },
    },
  });
}
