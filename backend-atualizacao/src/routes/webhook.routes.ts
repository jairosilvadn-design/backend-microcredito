import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { verifyMpSignature } from '../services/mercadopago/webhook-signature';
import { processPaymentWebhook } from '../services/payment-sync.service';

interface MpWebhookBody {
  id?: number | string;
  action?: string;
  type?: string;
  data?: { id?: string | number };
  user_id?: number | string;
  live_mode?: boolean;
}

export async function webhookRoutes(app: FastifyInstance) {
  app.post('/webhooks/mercadopago', async (req, reply) => {
    const body = (req.body ?? {}) as MpWebhookBody;
    const query = req.query as Record<string, string | undefined>;

    const dataId = query['data.id'] ?? (body.data?.id != null ? String(body.data.id) : undefined);
    const topic = query.type ?? body.type ?? query.topic ?? 'unknown';

    const sig = verifyMpSignature({
      xSignature: req.headers['x-signature'] as string | undefined,
      xRequestId: req.headers['x-request-id'] as string | undefined,
      dataId,
    });
    if (!sig.valid) {
      req.log.warn({ topic, dataId }, 'Webhook com assinatura inválida');
      return reply.code(401).send();
    }
    if (!dataId) return reply.code(200).send(); // nada a processar

    // Deduplicação: o MP reenvia notificações. eventId único no banco.
    const eventId = body.id != null ? String(body.id) : `${topic}:${dataId}:${sig.ts}`;
    try {
      await prisma.webhookEvent.create({
        data: {
          eventId,
          topic,
          resourceId: dataId,
          payload: body as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return reply.code(200).send(); // já recebido
      }
      throw err;
    }

    // Responde rápido (o MP considera falha se demorar) e processa depois.
    reply.code(200).send();

    if (topic === 'payment') {
      setImmediate(() => {
        processPaymentWebhook(eventId).catch((err) =>
          app.log.error({ err, eventId }, 'Falha ao processar webhook; o job de reprocessamento tentará de novo'),
        );
      });
    } else {
      await prisma.webhookEvent.update({ where: { eventId }, data: { processedAt: new Date() } });
    }
  });
}
