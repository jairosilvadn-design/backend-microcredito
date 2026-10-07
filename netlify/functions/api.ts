import { ligarBanco } from './_db-env';
ligarBanco();

import awsLambdaFastify from '@fastify/aws-lambda';
import type { Handler } from 'aws-lambda';

/** Toda a API (Fastify) atrás de uma única Netlify Function; o netlify.toml manda qualquer rota para cá. */
let proxy: ReturnType<typeof awsLambdaFastify> | null = null;

export const handler: Handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false; // não segura a resposta por conexões abertas
  if (!proxy) {
    const { buildApp } = await import('../../src/app');
    const app = await buildApp();
    proxy = awsLambdaFastify(app, { binaryMimeTypes: ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/heic'] });
  }
  return proxy(event, context);
};
