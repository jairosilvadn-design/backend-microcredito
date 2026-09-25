import cors from '@fastify/cors';
import type { FastifyInstance } from 'fastify';
import { env } from '../config/env';

/**
 * CORS restrito ao painel no Netlify.
 * - Lista branca exata de origens (sem curingas "*").
 * - credentials: false — a autenticação vai no header Authorization (Bearer),
 *   não em cookies. Isso elimina toda a classe de ataques CSRF por cookie.
 * - Requisições sem Origin (webhook do MP, curl, health check) não são
 *   afetadas por CORS; elas são protegidas por assinatura/autenticação.
 */
export async function registerCors(app: FastifyInstance) {
  const allowed = new Set(env.CORS_ORIGINS.split(',').map((o) => o.trim().replace(/\/$/, '')));
  const previewRegex = env.CORS_ORIGIN_REGEX ? new RegExp(env.CORS_ORIGIN_REGEX) : null;

  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowed.has(origin) || previewRegex?.test(origin)) return cb(null, true);
      return cb(null, false); // sem headers CORS -> o navegador bloqueia
    },
    // PUT e PATCH são usados para salvar configurações, níveis e cadastros.
    // Faltando um método aqui, o navegador bloqueia o envio antes de sair.
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
    credentials: false,
    maxAge: 600, // cache do preflight por 10 min
  });
}
