import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { env } from './config/env';
import { prisma } from './lib/prisma';
import { registerCors } from './plugins/cors';
import { oauthRoutes } from './routes/oauth.routes';
import { chargesRoutes } from './routes/charges.routes';
import { dashboardRoutes } from './routes/dashboard.routes';
import { webhookRoutes } from './routes/webhook.routes';
import { scheduleTokenRefresh } from './jobs/refresh-tokens.job';
import { scheduleWebhookRetry } from './jobs/webhook-retry.job';
import { scheduleDailyAudit } from './jobs/daily-audit.job';

// BigInt (mpUserId, mpPaymentId) precisa virar string no JSON
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

async function main() {
  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'production' ? 'info' : 'debug',
      // Segredos nunca vão para o log
      redact: ['req.headers.authorization', 'req.query.code', '*.access_token', '*.refresh_token', '*.client_secret'],
    },
    trustProxy: true,
  });

  await registerCors(app); // antes de tudo: o preflight OPTIONS precisa ser respondido
  await app.register(helmet);
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });

  app.get('/health', async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  });

  await app.register(oauthRoutes);
  await app.register(webhookRoutes);
  await app.register(chargesRoutes);
  await app.register(dashboardRoutes);

  if (env.ENABLE_JOBS) {
    scheduleTokenRefresh(app.log);
    scheduleWebhookRetry(app.log);
    scheduleDailyAudit(app.log);
    app.log.info('Jobs agendados nesta instância');
  }

  const shutdown = async () => {
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ port: env.PORT, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
