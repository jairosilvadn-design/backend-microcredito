import { Prisma, type Loan, type Merchant } from '@prisma/client';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { D, ZERO } from '../../lib/money';
import {
  addDaysYmd, dayBoundsSaoPaulo, dbDateToYmd, ymdRange, ymdSaoPaulo, ymdToDbDate,
} from '../../lib/dates';
import { createAvulsa, ChargeError } from '../charges.service';
import { sendChargeTemplate } from '../notifier/whatsapp';
import { decideDailyStatus, type RuleOutput } from './rules';
import { syncMerchantStatement } from './statement-sync.service';

type Log = { info: (o: object, m?: string) => void; warn: (o: object, m?: string) => void; error: (o: object, m?: string) => void };
const consoleLog: Log = {
  info: (o, m) => console.log(m ?? '', o),
  warn: (o, m) => console.warn(m ?? '', o),
  error: (o, m) => console.error(m ?? '', o),
};

// ---------------------------------------------------------------------------
// 1) Cálculo de UM dia para UM contrato (lê só o banco local)
// ---------------------------------------------------------------------------
export async function computeDay(loan: Loan, ymd: string, syncOk: boolean) {
  const { start, end } = dayBoundsSaoPaulo(ymd);

  const sales = await prisma.mpPayment.findMany({
    where: {
      merchantId: loan.merchantId,
      countsAsSale: true,
      excludedFromAudit: false,
      dateApproved: { gte: start, lt: end },
    },
    select: { transactionAmount: true, viaSplit: true },
  });

  let totalSales = ZERO, splitSales = ZERO, nonSplitSales = ZERO, nonSplitCount = 0;
  for (const s of sales) {
    totalSales = totalSales.plus(s.transactionAmount);
    if (s.viaSplit) splitSales = splitSales.plus(s.transactionAmount);
    else { nonSplitSales = nonSplitSales.plus(s.transactionAmount); nonSplitCount++; }
  }

  // Retido = o que efetivamente amortizou o contrato com cobranças aprovadas no dia
  // (comissões do split + cobranças avulsas pagas).
  const retainedAgg = await prisma.chargeAllocation.aggregate({
    _sum: { amount: true },
    where: { charge: { loanId: loan.id, approvedAt: { gte: start, lt: end } } },
  });
  const retained = retainedAgg._sum.amount ?? ZERO;

  const installment = await prisma.installment.findUnique({
    where: { loanId_dueDate: { loanId: loan.id, dueDate: ymdToDbDate(ymd) } },
  });
  const isDueDay = Boolean(installment);
  const dailyTarget = installment?.amountDue ?? ZERO;

  const prev = await prisma.dailyAudit.findFirst({
    where: { loanId: loan.id, referenceDate: { lt: ymdToDbDate(ymd) } },
    orderBy: { referenceDate: 'desc' },
  });

  const decision = decideDailyStatus({
    isDueDay,
    dailyTarget,
    retained,
    totalSales,
    nonSplitSales,
    nonSplitCount,
    prevConsecutive: prev?.consecutiveBypassDays ?? 0,
    graceDays: loan.graceDaysForBreach,
    syncOk,
    bypassMinAmount: D(env.BYPASS_MIN_AMOUNT),
    bypassMinCount: env.BYPASS_MIN_COUNT,
  });

  const data = {
    merchantId: loan.merchantId,
    totalSales,
    splitSales,
    nonSplitSales,
    retainedAmount: retained,
    dailyTarget,
    nonSplitPaymentCount: nonSplitCount,
    consecutiveBypassDays: decision.consecutiveBypassDays,
    isDueDay,
    syncOk,
    status: decision.status,
    notes: decision.notes.join(' ') || null,
    computedAt: new Date(),
  };

  const audit = await prisma.dailyAudit.upsert({
    where: { loanId_referenceDate: { loanId: loan.id, referenceDate: ymdToDbDate(ymd) } },
    create: { loanId: loan.id, referenceDate: ymdToDbDate(ymd), ...data },
    update: data,
  });

  // Parcelas vencidas até o dia auditado e não quitadas viram OVERDUE
  await prisma.installment.updateMany({
    where: { loanId: loan.id, dueDate: { lte: ymdToDbDate(ymd) }, status: { in: ['PENDING', 'PARTIAL'] } },
    data: { status: 'OVERDUE' },
  });

  return { audit, decision };
}

// ---------------------------------------------------------------------------
// 2) Ações automáticas por status
// ---------------------------------------------------------------------------
async function runActions(loan: Loan, merchant: Merchant, ymd: string, d: RuleOutput, log: Log) {
  const refDate = ymdToDbDate(ymd);

  if (d.status === 'RED') {
    await handleBreach(loan, ymd, d, log);
    return;
  }

  if (d.bypassToday) {
    await createAlertOnce(loan, 'SPLIT_BYPASS', refDate, {
      severity: 'WARNING',
      title: 'Venda fora do split (1º dia)',
      details: { referenceDate: ymd, consecutiveDays: d.consecutiveBypassDays, payments: await nonSplitPayments(loan.merchantId, [ymd]) },
    });
  }

  if (d.lowVolume && loan.status === 'ACTIVE') {
    const charge = await ensureAvulsaForDay(loan, merchant, ymd, log);
    await createAlertOnce(loan, 'LOW_VOLUME', refDate, {
      severity: 'WARNING',
      title: 'Volume baixo: parcela do dia não atingida',
      details: { referenceDate: ymd, notes: d.notes, charge } as Prisma.InputJsonValue,
    });
  }
}

/** AMARELO: cobrança avulsa das parcelas em aberto até o dia auditado. */
async function ensureAvulsaForDay(loan: Loan, merchant: Merchant, ymd: string, log: Log) {
  // Não empilha cobranças: se já existe avulsa pendente e válida, reaproveita.
  const pending = await prisma.charge.findFirst({
    where: { loanId: loan.id, type: 'AVULSA', status: 'PENDING', expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (pending) return { chargeId: pending.id, reused: true, paymentUrl: pending.paymentUrl };

  const open = await prisma.installment.findMany({
    where: { loanId: loan.id, dueDate: { lte: ymdToDbDate(ymd) }, status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] } },
    select: { amountDue: true, amountPaid: true },
  });
  const amount = open.reduce((acc, i) => acc.plus(i.amountDue.minus(i.amountPaid)), ZERO);
  if (amount.lessThanOrEqualTo(0)) return null;

  try {
    const dto = await createAvulsa({
      merchantId: merchant.id,
      amount: Number(amount.toFixed(2)),
      reason: 'LOW_VOLUME',
      idempotencyKey: `audit-${loan.id}-${ymd}`, // rodar o job 2x não gera 2 cobranças
    });

    let whatsapp: { sent: boolean; error?: string } = { sent: false, error: 'sem_link' };
    if (dto.paymentUrl && !dto.replayed) {
      const label = amount.toNumber().toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
      whatsapp = await sendChargeTemplate(merchant, label, dto.paymentUrl);
      if (whatsapp.sent) {
        await prisma.charge.update({ where: { id: dto.id }, data: { whatsappSentAt: new Date() } });
      }
    }
    return {
      chargeId: dto.id,
      amount: amount.toFixed(2),
      paymentUrl: dto.paymentUrl,
      whatsappUrl: dto.whatsappUrl ?? null, // fallback manual (wa.me) para o operador
      whatsappSent: whatsapp.sent,
      whatsappError: whatsapp.error ?? null,
    };
  } catch (err) {
    const code = err instanceof ChargeError ? err.code : 'unknown';
    log.error({ err, loanId: loan.id, ymd }, 'Falha ao gerar cobrança avulsa automática');
    return { error: code };
  }
}

/** VERMELHO: alerta de infração + rascunho da notificação de vencimento antecipado. */
async function handleBreach(loan: Loan, ymd: string, d: RuleOutput, log: Log) {
  const openBreach = await prisma.alert.findFirst({
    where: { loanId: loan.id, type: 'CONTRACT_BREACH', status: { in: ['OPEN', 'UNDER_REVIEW', 'CONFIRMED'] } },
  });

  const streakDates = await streakBypassDates(loan.id, ymd, d.consecutiveBypassDays);
  const evidence = await nonSplitPayments(loan.merchantId, streakDates);

  if (openBreach) {
    // Já existe um caso aberto: só anexa a nova evidência.
    const prevDetails = (openBreach.details ?? {}) as Record<string, unknown>;
    await prisma.alert.update({
      where: { id: openBreach.id },
      data: {
        details: {
          ...prevDetails,
          consecutiveDays: d.consecutiveBypassDays,
          lastReferenceDate: ymd,
          streakDates,
          payments: evidence,
        } as Prisma.InputJsonValue,
      },
    });
    return;
  }

  const fresh = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } });
  await prisma.$transaction(async (tx) => {
    const alert = await tx.alert.create({
      data: {
        merchantId: loan.merchantId,
        loanId: loan.id,
        type: 'CONTRACT_BREACH',
        severity: 'CRITICAL',
        title: `Infração contratual: vendas fora do split por ${d.consecutiveBypassDays} dias seguidos`,
        referenceDate: ymdToDbDate(ymd),
        details: {
          consecutiveDays: d.consecutiveBypassDays,
          firstReferenceDate: streakDates[0] ?? ymd,
          lastReferenceDate: ymd,
          streakDates,
          payments: evidence,
          outstandingBalance: fresh.outstandingBalance.toFixed(2),
        } as Prisma.InputJsonValue,
      },
    });
    // Nasce como RASCUNHO. Só um admin aprova (e só após o alerta ser confirmado).
    await tx.accelerationNotice.create({
      data: { loanId: loan.id, alertId: alert.id, amountDue: fresh.outstandingBalance, status: 'DRAFT' },
    });
    await tx.auditLog.create({
      data: {
        actor: 'system:cron-audit',
        action: 'breach.detected',
        entity: 'Loan',
        entityId: loan.id,
        after: { alertId: alert.id, streakDates, evidenceCount: evidence.length } as Prisma.InputJsonValue,
      },
    });
  });
  log.warn({ loanId: loan.id, ymd, days: d.consecutiveBypassDays }, 'Infração contratual detectada');
}

/** Dias (até ymd) que compõem a sequência atual de desvio. */
async function streakBypassDates(loanId: string, ymd: string, streak: number): Promise<string[]> {
  if (streak <= 0) return [];
  const recent = await prisma.dailyAudit.findMany({
    where: { loanId, referenceDate: { lte: ymdToDbDate(ymd) } },
    orderBy: { referenceDate: 'desc' },
    take: streak + 30, // folga para dias neutros no meio
  });
  const dates: string[] = [];
  for (const a of recent) {
    if (a.consecutiveBypassDays === 0) break;
    if (a.nonSplitPaymentCount > 0 && a.syncOk) dates.push(dbDateToYmd(a.referenceDate));
    if (dates.length >= streak) break;
  }
  return dates.reverse();
}

/** Evidência: pagamentos fora do split nos dias informados. */
async function nonSplitPayments(merchantId: string, dates: string[]) {
  const out: Array<Record<string, string | null>> = [];
  for (const ymd of dates) {
    const { start, end } = dayBoundsSaoPaulo(ymd);
    const rows = await prisma.mpPayment.findMany({
      where: { merchantId, countsAsSale: true, viaSplit: false, excludedFromAudit: false, dateApproved: { gte: start, lt: end } },
      orderBy: { dateApproved: 'asc' },
      take: 200,
    });
    for (const r of rows) {
      out.push({
        date: ymd,
        mpPaymentId: r.mpPaymentId.toString(),
        amount: r.transactionAmount.toFixed(2),
        method: r.paymentMethodId,
        type: r.paymentTypeId,
        operationType: r.operationType,
        pointOfInteraction: r.pointOfInteraction,
        approvedAt: r.dateApproved?.toISOString() ?? null,
      });
    }
  }
  return out;
}

async function createAlertOnce(
  loan: Loan,
  type: 'SPLIT_BYPASS' | 'LOW_VOLUME' | 'SYNC_FAILED',
  referenceDate: Date,
  a: { severity: 'INFO' | 'WARNING' | 'CRITICAL'; title: string; details: Prisma.InputJsonValue },
) {
  const exists = await prisma.alert.findFirst({ where: { loanId: loan.id, type, referenceDate } });
  if (exists) return exists;
  return prisma.alert.create({
    data: { merchantId: loan.merchantId, loanId: loan.id, type, referenceDate, ...a },
  });
}

// ---------------------------------------------------------------------------
// 3) Execução diária para toda a carteira
// ---------------------------------------------------------------------------
export interface RunOptions {
  referenceYmd?: string; // padrão: ontem (São Paulo)
  loanId?: string;
  withActions?: boolean; // padrão: true
  log?: Log;
}

export async function runDailyAudit(opts: RunOptions = {}) {
  const log = opts.log ?? consoleLog;
  const target = opts.referenceYmd ?? addDaysYmd(ymdSaoPaulo(), -1);
  const withActions = opts.withActions ?? true;

  const run = await prisma.jobRun.create({ data: { job: 'daily-audit' } });
  const stats = { loans: 0, days: 0, GREEN: 0, YELLOW: 0, RED: 0, syncFailures: 0, errors: 0 };

  try {
    const loans = await prisma.loan.findMany({
      where: { status: 'ACTIVE', disbursedAt: { not: null }, ...(opts.loanId ? { id: opts.loanId } : {}) },
      include: { merchant: true },
    });

    // Agrupa por comerciante: um sync de extrato por conta, mesmo com 2 contratos.
    const byMerchant = new Map<string, typeof loans>();
    for (const l of loans) byMerchant.set(l.merchantId, [...(byMerchant.get(l.merchantId) ?? []), l]);

    for (const merchantLoans of byMerchant.values()) {
      const merchant = merchantLoans[0]!.merchant;

      // Dias a processar por contrato: do último auditado + 1 até o alvo (backfill limitado).
      const plan = await Promise.all(merchantLoans.map(async (loan) => {
        const last = await prisma.dailyAudit.findFirst({
          where: { loanId: loan.id }, orderBy: { referenceDate: 'desc' },
        });
        const disbursed = ymdSaoPaulo(loan.disbursedAt!);
        const floor = addDaysYmd(target, -(env.AUDIT_BACKFILL_DAYS - 1));
        let from = last ? addDaysYmd(dbDateToYmd(last.referenceDate), 1) : disbursed;
        if (opts.referenceYmd) from = target; // execução manual de um dia específico
        if (from < floor) from = floor;
        if (from < disbursed) from = disbursed;
        return { loan, days: from <= target ? ymdRange(from, target) : [] };
      }));

      const earliest = plan.flatMap((p) => p.days).sort()[0];
      if (!earliest) continue;

      // Busca desde 2 dias antes para pegar vendas aprovadas perto da meia-noite.
      const sync = await syncMerchantStatement(merchant, addDaysYmd(earliest, -2));
      if (!sync.ok) {
        stats.syncFailures++;
        log.warn({ merchantId: merchant.id, error: sync.error }, 'Extrato indisponível');
        if (merchant.status !== 'OAUTH_REVOKED') {
          for (const { loan } of plan) {
            await createAlertOnce(loan, 'SYNC_FAILED', ymdToDbDate(target), {
              severity: 'WARNING',
              title: 'Não foi possível ler o extrato do comerciante',
              details: { error: sync.error ?? null, referenceDate: target },
            });
          }
        }
      }

      for (const { loan, days } of plan) {
        stats.loans++;
        for (const ymd of days) {
          try {
            const { decision } = await computeDay(loan, ymd, sync.ok);
            stats.days++;
            stats[decision.status]++;
            // Ações só no dia mais recente: um backfill de 3 dias não dispara 3 cobranças.
            if (withActions && ymd === target) {
              const freshLoan = await prisma.loan.findUniqueOrThrow({ where: { id: loan.id } });
              await runActions(freshLoan, merchant, ymd, decision, log);
            }
          } catch (err) {
            stats.errors++;
            log.error({ err, loanId: loan.id, ymd }, 'Falha na auditoria do dia');
            break; // não segue para os dias seguintes com o contador inconsistente
          }
        }
      }
    }

    await prisma.jobRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), ok: stats.errors === 0, stats },
    });
    log.info({ target, stats }, 'Auditoria diária concluída');
    return { target, stats };
  } catch (err) {
    await prisma.jobRun.update({
      where: { id: run.id },
      data: { finishedAt: new Date(), ok: false, stats, error: String(err).slice(0, 2000) },
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 4) Recalcular após revisão humana (ex.: pagamentos marcados como legítimos)
// ---------------------------------------------------------------------------
export async function recomputeFrom(loanId: string, fromYmd: string) {
  const loan = await prisma.loan.findUniqueOrThrow({ where: { id: loanId } });
  const audits = await prisma.dailyAudit.findMany({
    where: { loanId, referenceDate: { gte: ymdToDbDate(fromYmd) } },
    orderBy: { referenceDate: 'asc' },
  });
  const results: Array<{ date: string; status: string; consecutive: number }> = [];
  for (const a of audits) {
    // Recalcula SEM ações: não gera cobranças nem alertas retroativos.
    const { decision } = await computeDay(loan, dbDateToYmd(a.referenceDate), a.syncOk);
    results.push({ date: dbDateToYmd(a.referenceDate), status: decision.status, consecutive: decision.consecutiveBypassDays });
  }
  return results;
}
