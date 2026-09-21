import cron from 'node-cron';
import type { FastifyBaseLogger } from 'fastify';
import { prisma } from '../lib/prisma';
import { processPaymentWebhook } from '../services/payment-sync.service';

let running = false;

/** Reprocessa webhooks de pagamento que falharam ou ficaram pendentes (ex.: deploy no meio). */
export function scheduleWebhookRetry(log: FastifyBaseLogger) {
  cron.schedule('*/5 * * * *', async () => {
    if (running) return;
    running = true;
    try {
      const stuck = await prisma.webhookEvent.findMany({
        where: {
          topic: 'payment',
          processedAt: null,
          receivedAt: { lt: new Date(Date.now() - 2 * 60_000), gt: new Date(Date.now() - 3 * 86400_000) },
        },
        orderBy: { receivedAt: 'asc' },
        take: 100,
      });
      for (const ev of stuck) {
        await processPaymentWebhook(ev.eventId).catch((err) =>
          log.warn({ err, eventId: ev.eventId }, 'Reprocessamento falhou'),
        );
      }
    } finally {
      running = false;
    }
  }, { timezone: 'America/Sao_Paulo' });
}
