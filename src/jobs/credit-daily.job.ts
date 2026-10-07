import cron from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { dbDateToYmd, ymdSaoPaulo, ymdToDbDate } from '../lib/dates';
import { TX_OPTS, paraParcelaFato, recalcularContrato, saldoDaParcela, travarContrato } from '../services/credit/ledger.service';
import { buildMessage } from '../services/credit/contract.service';
import { getSettings } from '../services/credit/settings.service';

/**
 * Régua diária do microcrédito (07:00, horário de Brasília):
 *  1. recalcula cada contrato (motor financeiro): atraso, multa e juros, saldo e inadimplência;
 *  2. gera a mensagem pronta do dia (lembrete) e de cada atraso;
 *  3. atualiza o semáforo do cliente: EM DIA, ATRASADO ou INADIMPLENTE;
 *  4. marca o contrato como inadimplente após 30 dias de atraso.
 * As mensagens ficam pendentes no painel — quem envia é o operador, pelo WhatsApp.
 */
let running = false;

export async function runCreditDaily(log: FastifyBaseLogger) {
  if (running) return null;
  running = true;
  const today = ymdSaoPaulo();
  const todayDate = ymdToDbDate(today);
  const stats = { lembretes: 0, atrasos: 0, marcadasAtraso: 0, inadimplentes: 0 };
  const run = await prisma.jobRun.create({ data: { job: 'credit-daily' } });

  try {
    const settings = await getSettings();

    // 1) Recalcula cada contrato em andamento pelo motor financeiro: situação das parcelas,
    //    multa e juros do dia, saldo, semáforo do cliente e inadimplência (30+ dias).
    //    Inclui os já inadimplentes — antes eles paravam de acumular mora e sumiam das cobranças.
    const contratos = await prisma.creditContract.findMany({ where: { status: { in: ['ACTIVE', 'DEFAULTED'] } }, select: { id: true, status: true } });
    for (const c of contratos) {
      try {
        const antes = await prisma.creditInstallment.count({ where: { contractId: c.id, status: 'OVERDUE' } });
        const r = await prisma.$transaction(async (tx) => {
          await travarContrato(tx, c.id);
          return recalcularContrato(tx, c.id, today);
        }, TX_OPTS);
        const depois = await prisma.creditInstallment.count({ where: { contractId: c.id, status: 'OVERDUE' } });
        stats.marcadasAtraso += Math.max(0, depois - antes);
        if (r.status === 'DEFAULTED' && c.status !== 'DEFAULTED') stats.inadimplentes++;
      } catch (err) {
        // Um contrato com problema não pode parar a régua dos outros.
        log.error({ err, contractId: c.id }, 'Falha ao recalcular contrato na régua diária');
      }
    }

    // 2) Mensagens prontas do dia, com o valor já recalculado.
    const abertas = await prisma.creditInstallment.findMany({
      where: { status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] }, dueDate: { lte: todayDate }, contract: { status: { in: ['ACTIVE', 'DEFAULTED'] } } },
      include: { contract: { include: { borrower: true } } },
    });

    for (const i of abertas) {
      const due = dbDateToYmd(i.dueDate);
      const saldo = saldoDaParcela(paraParcelaFato(i), today, i.contract);
      if (saldo.falta.lessThanOrEqualTo(0)) continue;
      const lateDays = saldo.diasAtraso;
      const totalDue = Number(saldo.falta.toFixed(2));
      const firstName = i.contract.borrower.name.split(' ')[0] ?? i.contract.borrower.name;

      if (lateDays > 0) {
        const message = buildMessage('ATRASO', {
          firstName, contractNumber: i.contract.number, installmentSeq: i.sequence, installmentsCount: i.contract.installmentsCount,
          amount: Number(i.amountDue), dueDate: due, lateDays, totalDue, pixKey: i.contract.payToPixKey, pixOwner: settings.pixOwner,
        });
        const created = await prisma.creditNotification.createMany({
          data: [{ borrowerId: i.contract.borrowerId, contractId: i.contractId, installmentId: i.id, kind: 'ATRASO', referenceDate: todayDate, message }],
          skipDuplicates: true,
        });
        stats.atrasos += created.count;
      } else {
        const message = buildMessage('LEMBRETE', {
          firstName, contractNumber: i.contract.number, installmentSeq: i.sequence, installmentsCount: i.contract.installmentsCount,
          amount: totalDue, dueDate: due, pixKey: i.contract.payToPixKey, pixOwner: settings.pixOwner,
        });
        const created = await prisma.creditNotification.createMany({
          data: [{ borrowerId: i.contract.borrowerId, contractId: i.contractId, installmentId: i.id, kind: 'LEMBRETE', referenceDate: todayDate, message }],
          skipDuplicates: true,
        });
        stats.lembretes += created.count;
      }
    }

    await prisma.jobRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), ok: true, stats: stats as Prisma.InputJsonValue } });
    log.info({ today, stats }, 'Régua de cobrança do dia concluída');
    return stats;
  } catch (err) {
    await prisma.jobRun.update({ where: { id: run.id }, data: { finishedAt: new Date(), ok: false, error: String(err).slice(0, 2000) } });
    log.error({ err }, 'Falha na régua de cobrança');
    return null;
  } finally {
    running = false;
  }
}

export function scheduleCreditDaily(log: FastifyBaseLogger) {
  cron.schedule('0 7 * * *', () => void runCreditDaily(log), { timezone: 'America/Sao_Paulo' });
}
