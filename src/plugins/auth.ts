import type { FastifyReply, FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';

/**
 * Verificação do ID token do Firebase Auth SEM o firebase-admin:
 * chaves públicas do Google + checagem de issuer/audience conforme a doc
 * "Verify ID tokens using a third-party JWT library". jose faz cache das chaves.
 */
const FIREBASE_JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'),
);

declare module 'fastify' {
  interface FastifyRequest {
    operator?: { id: string; email: string; role: string };
  }
}

export async function requireOperator(req: FastifyRequest, reply: FastifyReply) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return reply.code(401).send({ error: 'unauthorized' });

  try {
    const { payload } = await jwtVerify(auth.slice(7), FIREBASE_JWKS, {
      issuer: `https://securetoken.google.com/${env.FIREBASE_PROJECT_ID}`,
      audience: env.FIREBASE_PROJECT_ID,
      algorithms: ['RS256'],
    });

    const firebase = payload.firebase as { sign_in_provider?: string } | undefined;
    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : undefined;
    const provedor = firebase?.sign_in_provider ?? '';

    if (!payload.sub || !email) return reply.code(401).send({ error: 'unauthorized' });

    // Entrada pelo Google ou por e-mail e senha. Em ambos os casos, o e-mail
    // ainda precisa estar cadastrado como operador (a checagem abaixo).
    const PROVEDORES = ['google.com', 'password'];
    if (!PROVEDORES.includes(provedor)) {
      return reply.code(403).send({ error: 'provider_not_allowed', message: 'Forma de login não permitida.' });
    }
    // No Google o e-mail já vem verificado pela própria conta. No e-mail e senha,
    // exigimos a confirmação por e-mail para ninguém entrar com endereço alheio.
    if (provedor === 'password' && payload.email_verified !== true) {
      return reply.code(403).send({
        error: 'email_not_verified',
        message: 'Confirme seu e-mail pelo link que enviamos antes de entrar.',
      });
    }

    // Login Google não basta: o e-mail precisa estar na lista de operadores.
    const op = await prisma.operator.findUnique({ where: { email } });
    if (!op) return reply.code(403).send({ error: 'forbidden' });

    req.operator = { id: op.id, email: op.email, role: op.role };
  } catch {
    return reply.code(401).send({ error: 'unauthorized' });
  }
}

/** preHandler adicional: exige papel admin (usar depois de requireOperator). */
export async function requireAdmin(req: FastifyRequest, reply: FastifyReply) {
  if (req.operator?.role !== 'admin') return reply.code(403).send({ error: 'admin_only' });
}
