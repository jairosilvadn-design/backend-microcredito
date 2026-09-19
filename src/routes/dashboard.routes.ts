import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { requireAdmin, requireOperator } from '../plugins/auth';
import { addDaysYmd, dayBoundsSaoPaulo, dbDateToYmd, isValidYmd, ymdSaoPaulo, ymdToDbDate } from '../lib/dates';
import { recomputeFrom, runDailyAudit } from '../services/audit/daily-audit.service';

const ymd = z.string().refine(isValidYmd, 'Data no formato AAAA-MM-DD');
const uuid = z.string().uuid();

export async function dashboardRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireOperator);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.code(400).send({ error: 'validation_error', details: err.flatten().fieldErrors });
    }
    req.log.error({ err }, 'Erro na rota do dashboard');
    return reply.code(500).send({ error: 'internal_error' });
  });

  /** Quem sou eu (o frontend usa para mostrar botões de admin). */
  app.get('/api/me', async (req) => req.operator);

  // -------------------------------------------------------------------------
  // Visão geral do semáforo
  // -------------------------------------------------------------------------
  app.get('/api/dashboard/overview', async (req) => {
    const q = z.object({ date: ymd.optional() }).parse(req.query);
    const date = q.date ?? addDaysYmd(ymdSaoPaulo(), -1);

    const loans = await prisma.loan.findMany({
      where: { status: { in: ['ACTIVE', 'ACCELERATED'] } },
      include: {
        merchant: { select: { id: true, tradeName: true, legalName: true, whatsapp: true, status: true } },
        dailyAudits: { where: { referenceDate: ymdToDbDate(date) }, take: 1 },
      },
      orderBy: { createdAt: 'asc' },
    });

    const alertCounts = await prisma.alert.groupBy({
      by: ['merchantId'],
      where: { status: { in: ['OPEN', 'UNDER_REVIEW', 'CONFIRMED'] } },
      _count: { _all: true },
    });
    const alertsByMerchant = new Map(alertCounts.map((a) => [a.merchantId, a._count._all]));

    const rows = loans.map((l) => {
      const a = l.dailyAudits[0];
      return {
        merchantId: l.merchantId,
        merchantName: l.merchant.tradeName ?? l.merchant.legalName,
        merchantStatus: l.merchant.status,
        loanId: l.id,
        contractNumber: l.contractNumber,
        loanStatus: l.status,
        outstandingBalance: l.outstandingBalance.toFixed(2),
        dailyInstallment: l.dailyInstallment.toFixed(2),
        status: a?.status ?? null, // null = ainda não auditado
        retained: a?.retainedAmount.toFixed(2) ?? null,
        target: a?.dailyTarget.toFixed(2) ?? null,
        totalSales: a?.totalSales.toFixed(2) ?? null,
        splitSales: a?.splitSales.toFixed(2) ?? null,
        nonSplitSales: a?.nonSplitSales.toFixed(2) ?? null,
        consecutiveBypassDays: a?.consecutiveBypassDays ?? 0,
        syncOk: a?.syncOk ?? null,
        notes: a?.notes ?? null,
        openAlerts: alertsByMerchant.get(l.merchantId) ?? 0,
      };
    });

    const summary = { GREEN: 0, YELLOW: 0, RED: 0, PENDING: 0 };
    for (const r of rows) summary[r.status ?? 'PENDING']++;

    const lastRun = await prisma.jobRun.findFirst({ where: { job: 'daily-audit' }, orderBy: { startedAt: 'desc' } });

    return { date, summary, rows, lastRun };
  });

  /** Histórico de auditorias de um comerciante (gráfico/tabela no detalhe). */
  app.get('/api/merchants/:id/audits', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { days } = z.object({ days: z.coerce.number().int().min(1).max(180).default(30) }).parse(req.query);
    const since = addDaysYmd(ymdSaoPaulo(), -days);
    const audits = await prisma.dailyAudit.findMany({
      where: { merchantId: id, referenceDate: { gte: ymdToDbDate(since) } },
      orderBy: { referenceDate: 'desc' },
    });
    return audits.map((a) => ({ ...a, referenceDate: dbDateToYmd(a.referenceDate) }));
  });

  /** Extrato classificado de um dia: evidência e calibragem das regras. */
  app.get('/api/merchants/:id/statement', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { date } = z.object({ date: ymd }).parse(req.query);
    const { start, end } = dayBoundsSaoPaulo(date);
    const rows = await prisma.mpPayment.findMany({
      where: { merchantId: id, OR: [{ dateApproved: { gte: start, lt: end } }, { dateCreated: { gte: start, lt: end } }] },
      orderBy: { dateCreated: 'asc' },
      select: {
        mpPaymentId: true, status: true, operationType: true, paymentMethodId: true, paymentTypeId: true,
        pointOfInteraction: true, transactionAmount: true, applicationFee: true, viaSplit: true,
        countsAsSale: true, excludedFromAudit: true, excludedReason: true, dateApproved: true, dateCreated: true,
      },
    });
    return { date, rows };
  });

  // -------------------------------------------------------------------------
  // Alertas e revisão humana
  // -------------------------------------------------------------------------
  app.get('/api/alerts', async (req) => {
    const alertStatus = z.enum(['OPEN', 'UNDER_REVIEW', 'CONFIRMED', 'DISMISSED', 'RESOLVED']);
    const q = z.object({
      status: z.string().default('OPEN,UNDER_REVIEW,CONFIRMED')
        .transform((s) => s.split(',').filter(Boolean))
        .pipe(z.array(alertStatus).min(1)),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }).parse(req.query);
    const statuses = q.status;

    const alerts = await prisma.alert.findMany({
      where: { status: { in: statuses } },
      include: {
        merchant: { select: { tradeName: true, legalName: true, whatsapp: true } },
        notice: true,
        reviewedBy: { select: { email: true } },
      },
      orderBy: [{ severity: 'desc' }, { createdAt: 'desc' }],
      take: q.limit,
    });
    return alerts.map((a) => ({
      ...a,
      referenceDate: a.referenceDate ? dbDateToYmd(a.referenceDate) : null,
      merchantName: a.merchant.tradeName ?? a.merchant.legalName,
    }));
  });

  const reviewSchema = z.object({
    decision: z.enum(['START_REVIEW', 'CONFIRM', 'DISMISS', 'RESOLVE']),
    note: z.string().max(2000).optional(),
    // DISMISS: pagamentos que o operador comprovou serem legítimos
    excludePaymentIds: z.array(z.string().regex(/^\d+$/)).max(500).optional(),
  });

  app.post('/api/alerts/:id/review', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = reviewSchema.parse(req.body);
    const alert = await prisma.alert.findUnique({ where: { id }, include: { notice: true } });
    if (!alert) return reply.code(404).send({ error: 'not_found' });
    if (['DISMISSED', 'RESOLVED'].includes(alert.status)) {
      return reply.code(409).send({ error: 'already_closed' });
    }
    if (body.decision === 'DISMISS' && !body.note) {
      return reply.code(400).send({ error: 'note_required', message: 'Descreva por que o alerta é um falso positivo' });
    }

    const nextStatus = {
      START_REVIEW: 'UNDER_REVIEW', CONFIRM: 'CONFIRMED', DISMISS: 'DISMISSED', RESOLVE: 'RESOLVED',
    }[body.decision] as 'UNDER_REVIEW' | 'CONFIRMED' | 'DISMISSED' | 'RESOLVED';

    let excluded = 0;
    await prisma.$transaction(async (tx) => {
      await tx.alert.update({
        where: { id },
        data: { status: nextStatus, reviewedById: req.operator!.id, reviewedAt: new Date(), reviewNote: body.note ?? null },
      });
      if (body.decision === 'DISMISS') {
        if (alert.notice && alert.notice.status === 'DRAFT') {
          await tx.accelerationNotice.update({ where: { id: alert.notice.id }, data: { status: 'CANCELLED' } });
        }
        if (body.excludePaymentIds?.length) {
          const r = await tx.mpPayment.updateMany({
            where: { merchantId: alert.merchantId, mpPaymentId: { in: body.excludePaymentIds.map(BigInt) } },
            data: { excludedFromAudit: true, excludedReason: `Alerta ${id}: ${body.note}`.slice(0, 500) },
          });
          excluded = r.count;
        }
      }
      await tx.auditLog.create({
        data: {
          operatorId: req.operator!.id,
          actor: `operator:${req.operator!.email}`,
          action: `alert.${body.decision.toLowerCase()}`,
          entity: 'Alert',
          entityId: id,
          before: { status: alert.status },
          after: { status: nextStatus, note: body.note ?? null, excluded } as Prisma.InputJsonValue,
        },
      });
    });

    // Pagamentos excluídos mudam o histórico: recalcula o contador a partir do dia afetado.
    let recomputed: Awaited<ReturnType<typeof recomputeFrom>> = [];
    if (excluded > 0 && alert.loanId) {
      const details = (alert.details ?? {}) as { firstReferenceDate?: string; referenceDate?: string };
      const from = details.firstReferenceDate ?? details.referenceDate
        ?? (alert.referenceDate ? dbDateToYmd(alert.referenceDate) : addDaysYmd(ymdSaoPaulo(), -7));
      recomputed = await recomputeFrom(alert.loanId, from);
    }
    return { ok: true, status: nextStatus, excluded, recomputed };
  });

  // -------------------------------------------------------------------------
  // Notificação de vencimento antecipado (somente admin)
  // -------------------------------------------------------------------------
  app.post('/api/notices/:id/approve', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const notice = await prisma.accelerationNotice.findUnique({ where: { id }, include: { alert: true, loan: true } });
    if (!notice) return reply.code(404).send({ error: 'not_found' });
    if (notice.status !== 'DRAFT') return reply.code(409).send({ error: 'not_draft' });
    if (notice.alert.status !== 'CONFIRMED') {
      return reply.code(409).send({ error: 'alert_not_confirmed', message: 'Confirme o alerta antes de aprovar a notificação' });
    }

    const result = await prisma.$transaction(async (tx) => {
      const loan = await tx.loan.update({
        where: { id: notice.loanId },
        data: { status: 'ACCELERATED', acceleratedAt: new Date() },
      });
      const updated = await tx.accelerationNotice.update({
        where: { id },
        data: {
          status: 'APPROVED',
          approvedById: req.operator!.id,
          approvedAt: new Date(),
          amountDue: loan.outstandingBalance, // saldo atualizado no momento da aprovação
        },
      });
      await tx.auditLog.create({
        data: {
          operatorId: req.operator!.id,
          actor: `operator:${req.operator!.email}`,
          action: 'loan.accelerate',
          entity: 'Loan',
          entityId: loan.id,
          before: { status: notice.loan.status },
          after: { status: 'ACCELERATED', noticeId: id, amountDue: loan.outstandingBalance.toFixed(2) },
        },
      });
      return updated;
    });
    return result;
  });

  app.post('/api/notices/:id/sent', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { channel, documentUrl } = z.object({
      channel: z.enum(['whatsapp', 'email', 'cartorio', 'correios']),
      documentUrl: z.string().url().optional(),
    }).parse(req.body);
    const r = await prisma.accelerationNotice.updateMany({
      where: { id, status: 'APPROVED' },
      data: { status: 'SENT', sentAt: new Date(), sentChannel: channel, documentUrl: documentUrl ?? undefined },
    });
    if (r.count !== 1) return reply.code(409).send({ error: 'not_approved' });
    await prisma.auditLog.create({
      data: { operatorId: req.operator!.id, actor: `operator:${req.operator!.email}`, action: 'notice.sent', entity: 'AccelerationNotice', entityId: id, after: { channel } },
    });
    return { ok: true };
  });

  app.post('/api/notices/:id/cancel', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { note } = z.object({ note: z.string().min(3).max(2000) }).parse(req.body);
    const r = await prisma.accelerationNotice.updateMany({
      where: { id, status: { in: ['DRAFT', 'APPROVED'] } },
      data: { status: 'CANCELLED' },
    });
    if (r.count !== 1) return reply.code(409).send({ error: 'cannot_cancel' });
    await prisma.auditLog.create({
      data: { operatorId: req.operator!.id, actor: `operator:${req.operator!.email}`, action: 'notice.cancel', entity: 'AccelerationNotice', entityId: id, after: { note } },
    });
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Execução manual da auditoria (admin) — útil para testes e reprocessamento
  // -------------------------------------------------------------------------
  app.post('/api/audit/run', { preHandler: requireAdmin }, async (req) => {
    const body = z.object({
      date: ymd.optional(),
      loanId: uuid.optional(),
      withActions: z.boolean().default(false), // manual: por padrão NÃO gera cobranças
    }).parse(req.body ?? {});
    return runDailyAudit({ referenceYmd: body.date, loanId: body.loanId, withActions: body.withActions, log: req.log });
  });
}
