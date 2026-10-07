import { copiarVariaveis, ligarBanco } from './_db-env';

/**
 * Toda a API (Fastify) atrás de uma Netlify Function no formato novo (Request/Response),
 * que enxerga o banco do Netlify via `Netlify.env`.
 */
type App = Awaited<ReturnType<typeof import('../src/app')['buildApp']>>;
let app: App | null = null;

const VARIAVEIS = [
  'NODE_ENV', 'FIREBASE_PROJECT_ID', 'CORS_ORIGINS', 'CORS_ORIGIN_REGEX', 'TOKEN_ENC_KEYS', 'TOKEN_ENC_ACTIVE_KID',
  'APP_PUBLIC_URL', 'PIX_DEFAULT_PAYER_EMAIL', 'MP_CLIENT_ID', 'MP_CLIENT_SECRET', 'MP_REDIRECT_URI', 'MP_WEBHOOK_SECRET',
  'MP_PLATFORM_ACCESS_TOKEN', 'MP_PLATFORM_USER_ID', 'WHATSAPP_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID',
];

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export default async (req: Request) => {
  if (!app) {
    try {
      copiarVariaveis(VARIAVEIS);
      ligarBanco();
      const { buildApp } = await import('../src/app');
      app = await buildApp();
      await app.ready();
    } catch (err) {
      // Mostra só os NOMES das variáveis com problema (nunca valores).
      const msg = err instanceof Error ? err.message : String(err);
      console.error('Falha ao iniciar a API:', msg);
      return json(503, { error: 'startup_failed', message: /^Variáveis de ambiente/.test(msg) ? msg : 'Falha ao iniciar a API. Veja os logs da função no Netlify.' });
    }
  }

  const url = new URL(req.url);
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.from(await req.arrayBuffer());
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => { headers[k] = v; });
  const res = await app.inject({ method: req.method as never, url: url.pathname + url.search, headers, payload: body });

  const out = new Headers();
  for (const [k, v] of Object.entries(res.headers)) {
    if (Array.isArray(v)) v.forEach((x) => out.append(k, x)); else if (v !== undefined) out.set(k, String(v));
  }
  out.delete('content-length'); // o runtime recalcula
  return new Response([204, 304].includes(res.statusCode) ? null : res.rawPayload, { status: res.statusCode, headers: out });
};

export const config = { path: ['/api/*', '/p/*', '/oauth/*', '/webhooks/*', '/health'] };
