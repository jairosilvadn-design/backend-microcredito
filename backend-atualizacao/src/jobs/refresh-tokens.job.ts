import cron from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { refreshMerchantToken, type RefreshResult } from '../services/mercadopago/oauth.service';

let running = false;

export async function runTokenRefresh(log: FastifyBaseLogger) {
  if (running) return;
  running = true;
  const stats: Record<RefreshResult, number> = { refreshed: 0, skipped: 0, revoked: 0, failed: 0 };

  try {
    const limit = new Date(Date.now() + env.TOKEN_REFRESH_WINDOW_DAYS * 86400_000);
    const due = await prisma.oAuthToken.findMany({
      where: {
        expiresAt: { lt: limit },
        merchant: { status: { in: ['ACTIVE', 'SUSPENDED'] } },
        refreshFailures: { lt: 10 }, // depois disso, só com ação manual
      },
      select: { merchantId: true },
      orderBy: { expiresAt: 'asc' },
      take: 200,
    });

    for (const { merchantId } of due) {
      try {
        stats[await refreshMerchantToken(merchantId)]++;
      } catch (err) {
        stats.failed++;
        log.error({ err, merchantId }, 'Erro ao renovar token');
      }
      await new Promise((r) => setTimeout(r, 300)); // gentil com o rate limit do MP
    }
    log.info({ stats, candidates: due.length }, 'Renovação de tokens concluída');
  } finally {
    running = false;
  }
}

export function scheduleTokenRefresh(log: FastifyBaseLogger) {
  // De hora em hora, no minuto 15. A janela de 30 dias dá centenas de tentativas
  // antes de qualquer token realmente expirar.
  cron.schedule('15 * * * *', () => void runTokenRefresh(log), { timezone: 'America/Sao_Paulo' });
}
