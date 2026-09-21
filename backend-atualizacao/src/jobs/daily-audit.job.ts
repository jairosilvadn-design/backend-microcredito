import cron from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config/env';
import { runDailyAudit } from '../services/audit/daily-audit.service';

let running = false;

export async function runDailyAuditSafely(log: FastifyBaseLogger) {
  if (running) {
    log.warn('Auditoria diária já em execução; ignorando disparo duplicado');
    return null;
  }
  running = true;
  try {
    return await runDailyAudit({ log });
  } catch (err) {
    log.error({ err }, 'Auditoria diária falhou');
    return null;
  } finally {
    running = false;
  }
}

export function scheduleDailyAudit(log: FastifyBaseLogger) {
  if (!cron.validate(env.AUDIT_CRON)) throw new Error(`AUDIT_CRON inválido: ${env.AUDIT_CRON}`);
  cron.schedule(env.AUDIT_CRON, () => void runDailyAuditSafely(log), { timezone: 'America/Sao_Paulo' });
}
