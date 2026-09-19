import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env';
import { requireOperator } from '../plugins/auth';
import { createAuthorizationUrl, handleOAuthCallback, OAuthFlowError } from '../services/mercadopago/oauth.service';

export async function oauthRoutes(app: FastifyInstance) {
  /**
   * Operador gera o link de vinculação para enviar ao comerciante (WhatsApp).
   * POST /api/merchants/:id/oauth-link
   */
  app.post('/api/merchants/:id/oauth-link', { preHandler: requireOperator }, async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    try {
      const result = await createAuthorizationUrl(id, req.operator!.id);
      return reply.send(result);
    } catch (err) {
      if (err instanceof OAuthFlowError) return reply.code(409).send({ error: err.code, message: err.message });
      throw err;
    }
  });

  /**
   * Redirect URL cadastrada no painel do Mercado Pago.
   * GET /oauth/mercadopago/callback?code=...&state=...
   */
  app.get(
    '/oauth/mercadopago/callback',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const q = req.query as Record<string, string | undefined>;
      const fail = (reason: string) =>
        reply.redirect(`${env.APP_PUBLIC_URL}/vinculacao/erro?motivo=${encodeURIComponent(reason)}`);

      if (q.error) return fail('autorizacao_negada'); // comerciante clicou em "cancelar"
      if (!q.code || !q.state) return fail('parametros_ausentes');

      try {
        await handleOAuthCallback(q.code, q.state);
        return reply.redirect(`${env.APP_PUBLIC_URL}/vinculacao/sucesso`);
      } catch (err) {
        if (err instanceof OAuthFlowError) {
          req.log.warn({ code: err.code }, 'OAuth callback recusado');
          return fail(err.code);
        }
        req.log.error({ err }, 'Erro inesperado no callback OAuth');
        return fail('erro_interno');
      }
    },
  );
}
