import Fastify from 'fastify';
import helmet from '@fastify/helmet';
import compress from '@fastify/compress';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { env } from './config/env';
import { prisma } from './lib/prisma';
import { registerCors } from './plugins/cors';
import { oauthRoutes } from './routes/oauth.routes';
import { chargesRoutes } from './routes/charges.routes';
import { dashboardRoutes } from './routes/dashboard.routes';
import { merchantsRoutes } from './routes/merchants.routes';
import { creditRoutes } from './routes/credit.routes';
import { signatureRoutes } from './routes/signature.routes';
import { webhookRoutes } from './routes/webhook.routes';

// BigInt (mpUserId, mpPaymentId) precisa virar string no JSON
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

/** Monta o servidor (sem abrir porta e sem agendar jobs): usado pelo servidor tradicional e pela Netlify Function. */
export async function buildApp() {
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
  await app.register(compress, { global: true, threshold: 1024 }); // JSON cai de ~10x no celular
  await app.register(multipart, { limits: { fileSize: 6 * 1024 * 1024, files: 1, fields: 10 } });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });

  app.get('/health', async () => {
    await prisma.$queryRaw`SELECT 1`;
    return { ok: true };
  });

  await app.register(oauthRoutes);
  await app.register(webhookRoutes);
  await app.register(chargesRoutes);
  await app.register(dashboardRoutes);
  await app.register(merchantsRoutes);
  await app.register(creditRoutes);
  await app.register(signatureRoutes);
  return app;
}
