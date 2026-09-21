import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { D } from '../lib/money';
import { addDaysYmd, dbDateToYmd, isValidYmd, ymdSaoPaulo, ymdToDbDate } from '../lib/dates';
import { requireAdmin, requireOperator } from '../plugins/auth';

// ---------------------------------------------------------------------------
// Utilitários de cadastro
// ---------------------------------------------------------------------------
const onlyDigits = (s: string) => s.replace(/\D/g, '');

/** Aceita (17) 99999-9999, 17999999999 ou +55 17 99999-9999 e grava em E.164. */
export function normalizeWhatsapp(raw: string): string | null {
  let d = onlyDigits(raw);
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  if (!(d.length === 12 || d.length === 13) || !d.startsWith('55')) return null;
  return `+${d}`;
}

/** Datas de vencimento: a partir de firstYmd, pulando sábado e domingo se businessDaysOnly. */
export function buildDueDates(firstYmd: string, count: number, businessDaysOnly: boolean): string[] {
  const out: string[] = [];
  let d = firstYmd;
  while (out.length < count) {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay(); // 0 = domingo, 6 = sábado
    if (!businessDaysOnly || (dow !== 0 && dow !== 6)) out.push(d);
    d = addDaysYmd(d, 1);
  }
  return out;
}

/** Parcela diária arredondada para baixo; a última parcela absorve a diferença de centavos. */
export function buildAmounts(total: Prisma.Decimal, count: number): Prisma.Decimal[] {
  const daily = total.div(count).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN);
  const amounts = Array.from({ length: count }, () => daily);
  amounts[count - 1] = total.minus(daily.mul(count - 1));
  return amounts;
}

/** Taxa mensal simples aproximada, só para referência no contrato. */
export function approxMonthlyRate(principal: Prisma.Decimal, total: Prisma.Decimal, termDays: number, businessDaysOnly: boolean) {
  const months = termDays / (businessDaysOnly ? 22 : 30);
  if (months <= 0 || principal.lessThanOrEqualTo(0)) return D(0);
  return total.div(principal).minus(1).div(months).toDecimalPlaces(4);
}

const MSG: Record<string, string> = {
  legalName: 'Informe a razão social ou o nome completo',
  document: 'CPF (11 dígitos) ou CNPJ (14 dígitos)',
  ownerName: 'Informe o nome do responsável',
  ownerCpf: 'CPF do responsável com 11 dígitos',
  whatsapp: 'WhatsApp com DDD, ex.: (17) 99999-9999',
  email: 'E-mail inválido',
  addressCity: 'Informe a cidade',
  addressState: 'UF com 2 letras, ex.: SP',
  lgpdConsent: 'É obrigatório o consentimento assinado para leitura do extrato',
  principal: 'Valor emprestado inválido',
  totalPayable: 'Valor total a receber deve ser maior que o valor emprestado',
  termDays: 'Número de parcelas entre 1 e 365',
  splitPercent: 'Retenção por venda entre 0,01% e 99%',
  firstDueDate: 'Primeiro vencimento a partir de hoje',
  graceDaysForBreach: 'Dias de tolerância entre 1 e 10',
};

function sendValidation(reply: FastifyReply, err: z.ZodError) {
  const fields = Object.keys(err.flatten().fieldErrors);
  const message = fields.map((f) => MSG[f] ?? f).join(' · ') || 'Dados inválidos';
  return reply.code(400).send({ error: 'validation_error', message, fields });
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const merchantSchema = z.object({
  legalName: z.string().trim().min(3).max(200),
  tradeName: z.string().trim().max(200).optional().transform((v) => v || undefined),
  document: z.string().transform(onlyDigits).refine((v) => v.length === 11 || v.length === 14),
  ownerName: z.string().trim().min(3).max(200),
  ownerCpf: z.string().transform(onlyDigits).refine((v) => v.length === 11),
  whatsapp: z.string().transform((v) => normalizeWhatsapp(v) ?? '').refine((v) => v !== ''),
  email: z.string().trim().email().optional().or(z.literal('').transform(() => undefined)),
  addressCity: z.string().trim().min(2).max(100),
  addressState: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/),
  lgpdConsent: z.literal(true),
});

const merchantUpdateSchema = z.object({
  tradeName: z.string().trim().max(200).optional(),
  whatsapp: z.string().transform((v) => normalizeWhatsapp(v) ?? '').refine((v) => v !== '').optional(),
  email: z.string().trim().email().optional(),
  addressCity: z.string().trim().min(2).max(100).optional(),
  addressState: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).optional(),
});

const money = z.coerce.number().positive().max(1_000_000);

const loanSchema = z.object({
  principal: money,
  totalPayable: money,
  termDays: z.coerce.number().int().min(1).max(365),
  splitPercent: z.coerce.number().min(0.01).max(99),
  firstDueDate: z.string().refine(isValidYmd),
  businessDaysOnly: z.boolean().default(true),
  graceDaysForBreach: z.coerce.number().int().min(1).max(10).default(2),
  promissoryNoteRef: z.string().trim().max(200).optional(),
}).refine((l) => l.totalPayable > l.principal, { path: ['totalPayable'] })
  .refine((l) => l.firstDueDate >= ymdSaoPaulo(), { path: ['firstDueDate'] });

async function nextContractNumber(): Promise<string> {
  const year = ymdSaoPaulo().slice(0, 4);
  const count = await prisma.loan.count({ where: { contractNumber: { startsWith: `MC-${year}-` } } });
  return `MC-${year}-${String(count + 1).padStart(4, '0')}`;
}

async function audit(req: FastifyRequest, action: string, entity: string, entityId: string, after: unknown) {
  await prisma.auditLog.create({
    data: {
      operatorId: req.operator!.id,
      actor: `operator:${req.operator!.email}`,
      action,
      entity,
      entityId,
      after: after as Prisma.InputJsonValue,
    },
  });
}

const money2 = (d: Prisma.Decimal | null | undefined) => (d == null ? null : d.toFixed(2));

// ---------------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------------
export async function merchantsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireOperator);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) return sendValidation(reply, err);
    req.log.error({ err }, 'Erro nas rotas de comerciantes');
    return reply.code(500).send({ error: 'internal_error', message: 'Erro inesperado no servidor' });
  });

  /** Lista de comerciantes. ?eligible=pix traz só quem pode receber Pix com split. */
  app.get('/api/merchants', async (req) => {
    const { eligible } = z.object({ eligible: z.enum(['pix']).optional() }).parse(req.query);
    const merchants = await prisma.merchant.findMany({
      where: eligible === 'pix' ? { status: 'ACTIVE', loans: { some: { status: 'ACTIVE' } } } : {},
      include: {
        loans: {
          where: { status: { in: ['DRAFT', 'ACTIVE', 'ACCELERATED'] } },
          orderBy: { createdAt: 'desc' },
          select: { id: true, contractNumber: true, status: true, outstandingBalance: true, dailyInstallment: true, splitPercent: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
    return merchants.map((m) => ({
      id: m.id,
      name: m.tradeName ?? m.legalName,
      legalName: m.legalName,
      document: m.document,
      whatsapp: m.whatsapp,
      city: `${m.addressCity}/${m.addressState}`,
      status: m.status,
      loans: m.loans.map((l) => ({ ...l, outstandingBalance: money2(l.outstandingBalance), dailyInstallment: money2(l.dailyInstallment), splitPercent: money2(l.splitPercent) })),
    }));
  });

  /** Cadastro de comerciante. */
  app.post('/api/merchants', async (req, reply) => {
    const data = merchantSchema.parse(req.body);
    const exists = await prisma.merchant.findUnique({ where: { document: data.document } });
    if (exists) return reply.code(409).send({ error: 'duplicate_document', message: 'Já existe um comerciante com este CPF/CNPJ' });

    const { lgpdConsent: _c, ...fields } = data;
    const m = await prisma.merchant.create({ data: { ...fields, lgpdConsentAt: new Date() } });
    await audit(req, 'merchant.create', 'Merchant', m.id, { document: m.document, name: m.legalName });
    return reply.code(201).send({ id: m.id });
  });

  /** Detalhe do comerciante com contratos e parcelas. */
  app.get('/api/merchants/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const m = await prisma.merchant.findUnique({
      where: { id },
      include: {
        oauthToken: { select: { expiresAt: true, lastRefreshedAt: true, liveMode: true } },
        loans: {
          orderBy: { createdAt: 'desc' },
          include: { installments: { orderBy: { sequence: 'asc' } } },
        },
      },
    });
    if (!m) return reply.code(404).send({ error: 'not_found', message: 'Comerciante não encontrado' });

    return {
      id: m.id,
      legalName: m.legalName,
      tradeName: m.tradeName,
      document: m.document,
      ownerName: m.ownerName,
      ownerCpf: m.ownerCpf,
      whatsapp: m.whatsapp,
      email: m.email,
      addressCity: m.addressCity,
      addressState: m.addressState,
      status: m.status,
      mpLinked: Boolean(m.oauthToken),
      tokenExpiresAt: m.oauthToken?.expiresAt ?? null,
      createdAt: m.createdAt,
      loans: m.loans.map((l) => {
        const paid = l.installments.filter((i) => i.status === 'PAID').length;
        const overdue = l.installments.filter((i) => i.status === 'OVERDUE').length;
        return {
          id: l.id,
          contractNumber: l.contractNumber,
          status: l.status,
          principal: money2(l.principal),
          totalPayable: money2(l.totalPayable),
          outstandingBalance: money2(l.outstandingBalance),
          dailyInstallment: money2(l.dailyInstallment),
          splitPercent: money2(l.splitPercent),
          monthlyRate: l.monthlyRate.toFixed(4),
          termDays: l.termDays,
          businessDaysOnly: l.businessDaysOnly,
          graceDaysForBreach: l.graceDaysForBreach,
          firstDueDate: dbDateToYmd(l.firstDueDate),
          lastDueDate: l.installments.length ? dbDateToYmd(l.installments[l.installments.length - 1]!.dueDate) : null,
          disbursedAt: l.disbursedAt,
          installmentsPaid: paid,
          installmentsOverdue: overdue,
          installmentsTotal: l.installments.length,
        };
      }),
    };
  });

  /** Atualização de dados de contato. */
  app.patch('/api/merchants/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const data = merchantUpdateSchema.parse(req.body);
    const r = await prisma.merchant.updateMany({ where: { id }, data });
    if (r.count !== 1) return reply.code(404).send({ error: 'not_found', message: 'Comerciante não encontrado' });
    await audit(req, 'merchant.update', 'Merchant', id, data);
    return { ok: true };
  });

  /** Criação do contrato (nasce como RASCUNHO) com o cronograma de parcelas. */
  app.post('/api/merchants/:id/loans', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = loanSchema.parse(req.body);

    const merchant = await prisma.merchant.findUnique({ where: { id } });
    if (!merchant) return reply.code(404).send({ error: 'not_found', message: 'Comerciante não encontrado' });
    const open = await prisma.loan.findFirst({ where: { merchantId: id, status: { in: ['DRAFT', 'ACTIVE', 'ACCELERATED'] } } });
    if (open) {
      return reply.code(409).send({
        error: 'open_loan_exists',
        message: `Este comerciante já tem o contrato ${open.contractNumber} em aberto (${open.status}). Quite ou cancele antes de criar outro.`,
      });
    }

    const principal = D(body.principal).toDecimalPlaces(2);
    const total = D(body.totalPayable).toDecimalPlaces(2);
    const dueDates = buildDueDates(body.firstDueDate, body.termDays, body.businessDaysOnly);
    const amounts = buildAmounts(total, body.termDays);

    let contractNumber = await nextContractNumber();
    for (let attempt = 0; ; attempt++) {
      try {
        const loan = await prisma.$transaction(async (tx) => {
          const l = await tx.loan.create({
            data: {
              merchantId: id,
              contractNumber,
              principal,
              totalPayable: total,
              monthlyRate: approxMonthlyRate(principal, total, body.termDays, body.businessDaysOnly),
              termDays: body.termDays,
              dailyInstallment: amounts[0]!,
              splitPercent: D(body.splitPercent).toDecimalPlaces(2),
              businessDaysOnly: body.businessDaysOnly,
              graceDaysForBreach: body.graceDaysForBreach,
              promissoryNoteRef: body.promissoryNoteRef ?? null,
              firstDueDate: ymdToDbDate(dueDates[0]!),
              outstandingBalance: total,
              status: 'DRAFT',
            },
          });
          await tx.installment.createMany({
            data: dueDates.map((d, i) => ({ loanId: l.id, sequence: i + 1, dueDate: ymdToDbDate(d), amountDue: amounts[i]! })),
          });
          return l;
        });
        await audit(req, 'loan.create', 'Loan', loan.id, { contractNumber, principal: principal.toFixed(2), total: total.toFixed(2), termDays: body.termDays });
        return reply.code(201).send({
          id: loan.id,
          contractNumber,
          dailyInstallment: amounts[0]!.toFixed(2),
          lastInstallment: amounts[amounts.length - 1]!.toFixed(2),
          firstDueDate: dueDates[0],
          lastDueDate: dueDates[dueDates.length - 1],
        });
      } catch (err) {
        // Número de contrato repetido (dois cadastros ao mesmo tempo): tenta o próximo.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002' && attempt < 3) {
          contractNumber = `${contractNumber}-${attempt + 2}`;
          continue;
        }
        throw err;
      }
    }
  });

  /** Ativação do contrato (admin): marca o desembolso e liga a auditoria diária. */
  app.post('/api/loans/:id/activate', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const loan = await prisma.loan.findUnique({ where: { id }, include: { merchant: true } });
    if (!loan) return reply.code(404).send({ error: 'not_found', message: 'Contrato não encontrado' });
    if (loan.status !== 'DRAFT') return reply.code(409).send({ error: 'not_draft', message: 'Só contratos em rascunho podem ser ativados' });
    if (loan.merchant.status !== 'ACTIVE') {
      return reply.code(409).send({
        error: 'merchant_not_linked',
        message: 'Vincule a conta Mercado Pago do comerciante antes de ativar o contrato (a auditoria depende disso).',
      });
    }
    if (dbDateToYmd(loan.firstDueDate) < ymdSaoPaulo()) {
      return reply.code(409).send({
        error: 'first_due_in_past',
        message: 'O primeiro vencimento já passou. Cancele este rascunho e crie o contrato de novo com datas atualizadas.',
      });
    }

    await prisma.loan.update({ where: { id }, data: { status: 'ACTIVE', disbursedAt: new Date() } });
    await audit(req, 'loan.activate', 'Loan', id, { contractNumber: loan.contractNumber });
    return { ok: true };
  });

  /** Cancelamento de rascunho (admin). */
  app.post('/api/loans/:id/cancel', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const r = await prisma.loan.updateMany({ where: { id, status: 'DRAFT' }, data: { status: 'CANCELLED' } });
    if (r.count !== 1) return reply.code(409).send({ error: 'not_draft', message: 'Só contratos em rascunho podem ser cancelados' });
    await audit(req, 'loan.cancel', 'Loan', id, {});
    return { ok: true };
  });
}
