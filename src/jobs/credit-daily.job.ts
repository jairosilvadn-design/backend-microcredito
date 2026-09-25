import cron from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { dbDateToYmd, ymdSaoPaulo, ymdToDbDate } from '../lib/dates';
import { lateCharge } from '../services/credit/pricing.service';
import { buildMessage } from '../services/credit/contract.service';
import { getSettings } from '../services/credit/settings.service';

/**
 * Régua diária do microcrédito (07:00, horário de Brasília):
 *  1. marca como atrasada toda parcela vencida e ainda em aberto, com multa e juros;
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

    const abertas = await prisma.creditInstallment.findMany({
      where: { status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] }, dueDate: { lte: todayDate }, contract: { status: 'ACTIVE' } },
      include: { contract: { include: { borrower: true } } },
    });

    for (const i of abertas) {
      const due = dbDateToYmd(i.dueDate);
      const lateDays = Math.max(0, Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${due}T12:00:00Z`)) / 86400_000));
      const firstName = i.contract.borrower.name.split(' ')[0] ?? i.contract.borrower.name;

      if (lateDays > 0) {
        const charge = lateCharge(i.amountDue, lateDays, i.contract.lateFeePercent, i.contract.lateDailyPercent);
        if (i.status !== 'OVERDUE' || !i.lateCharge.equals(charge)) {
          await prisma.creditInstallment.update({ where: { id: i.id }, data: { status: 'OVERDUE', lateCharge: charge } });
          if (i.status !== 'OVERDUE') stats.marcadasAtraso++;
        }
        const totalDue = Number(i.amountDue.plus(charge).minus(i.amountPaid).toFixed(2));
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
          amount: Number(i.amountDue.minus(i.amountPaid)), dueDate: due, pixKey: i.contract.payToPixKey, pixOwner: settings.pixOwner,
        });
        const created = await prisma.creditNotification.createMany({
          data: [{ borrowerId: i.contract.borrowerId, contractId: i.contractId, installmentId: i.id, kind: 'LEMBRETE', referenceDate: todayDate, message }],
          skipDuplicates: true,
        });
        stats.lembretes += created.count;
      }
    }

    // Semáforo do cliente e inadimplência do contrato
    const ativos = await prisma.creditContract.findMany({
      where: { status: 'ACTIVE' },
      include: { installments: { where: { status: { in: ['OVERDUE', 'PARTIAL'] } } } },
    });
    for (const c of ativos) {
      const maxLate = c.installments.reduce((mx, i) => {
        const d = Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${dbDateToYmd(i.dueDate)}T12:00:00Z`)) / 86400_000);
        return Math.max(mx, d);
      }, 0);

      const status = maxLate >= 15 ? 'INADIMPLENTE' : maxLate > 0 ? 'ATRASADO' : 'ATIVO';
      await prisma.borrower.update({ where: { id: c.borrowerId }, data: { status } });
      if (maxLate >= 30) {
        await prisma.creditContract.update({ where: { id: c.id }, data: { status: 'DEFAULTED', defaultedAt: new Date() } });
        stats.inadimplentes++;
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
