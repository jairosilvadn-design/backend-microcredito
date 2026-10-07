import { ligarBanco } from './_db-env';
ligarBanco();

import awsLambdaFastify from '@fastify/aws-lambda';
import type { Handler } from 'aws-lambda';

/** Toda a API (Fastify) atrás de uma única Netlify Function; o netlify.toml manda qualquer rota para cá. */
let proxy: ReturnType<typeof awsLambdaFastify> | null = null;

export const handler: Handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false; // não segura a resposta por conexões abertas
  if (!proxy) {
    try {
      const { buildApp } = await import('../../src/app');
      const app = await buildApp();
      proxy = awsLambdaFastify(app, { binaryMimeTypes: ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic'] });
    } catch (err) {
      // Mostra só os NOMES das variáveis com problema (nunca valores), em vez de derrubar a função sem explicação.
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Falha ao iniciar a API:', msg);
      const seguro = /^Variáveis de ambiente/.test(msg) ? msg : 'Falha ao iniciar a API. Veja os logs da função no Netlify.';
      return { statusCode: 503, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ error: 'startup_failed', message: seguro }) };
    }
  }
  return proxy(event, context);
};
