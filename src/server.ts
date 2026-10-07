import { env } from './config/env';
import { prisma } from './lib/prisma';
import { buildApp } from './app';
import { scheduleTokenRefresh } from './jobs/refresh-tokens.job';
import { scheduleWebhookRetry } from './jobs/webhook-retry.job';
import { scheduleDailyAudit } from './jobs/daily-audit.job';
import { scheduleCreditDaily } from './jobs/credit-daily.job';

async function main() {
  const app = await buildApp();

  if (env.ENABLE_JOBS) {
    scheduleTokenRefresh(app.log);
    scheduleWebhookRetry(app.log);
    scheduleDailyAudit(app.log);
    scheduleCreditDaily(app.log);
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
