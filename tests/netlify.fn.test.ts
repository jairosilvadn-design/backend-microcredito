/** Chama a Netlify Function com eventos no formato Lambda, contra um Postgres local. */
import './setup-env';
process.env.NETLIFY_DATABASE_URL = process.env.DB_TEST_URL ?? '';
delete process.env.DATABASE_URL;
let pass = 0, fail = 0;
const check = (n: string, c: boolean, x = '') => { c ? pass++ : fail++; console.log(`${c ? '✔' : '✘'} ${n}${c ? '' : ' ' + x}`); };
const ev = (path: string, method = 'GET', headers: Record<string, string> = {}) => ({
  httpMethod: method, path, headers: { host: 'x.netlify.app', ...headers }, multiValueHeaders: {}, queryStringParameters: null, multiValueQueryStringParameters: null,
  body: null, isBase64Encoded: false, requestContext: {}, resource: '', pathParameters: null, stageVariables: null,
}) as never;
(async () => {
  const { handler } = await import('../netlify/functions/api');
  const ctx = {} as never;
  const h = await handler(ev('/health'), ctx, () => undefined) as { statusCode: number; body: string };
  check(`/health responde 200 e fala com o banco (${h.body})`, h.statusCode === 200 && /ok/.test(h.body), JSON.stringify(h));
  const a = await handler(ev('/api/credito/painel'), ctx, () => undefined) as { statusCode: number };
  check('rota protegida sem login devolve 401', a.statusCode === 401);
  const c = await handler(ev('/api/credito/painel', 'OPTIONS', { origin: 'https://test.local', 'access-control-request-method': 'GET' }), ctx, () => undefined) as { statusCode: number; headers: Record<string, string> };
  check('CORS libera a origem do painel', c.statusCode === 204 && c.headers['access-control-allow-origin'] === 'https://test.local', JSON.stringify(c.headers));
  const t = await handler(ev('/p/contrato/' + 'x'.repeat(30)), ctx, () => undefined) as { statusCode: number };
  check('link público de assinatura inválido devolve 410 (sem login)', t.statusCode === 410, String(t.statusCode));
  const { default: job } = await import('../netlify/functions/credit-daily');
  const r = await job();
  check('tarefa diária executa', (await r.json()).ok === true);
  console.log(`\n${pass} passaram, ${fail} falharam`); process.exit(fail ? 1 : 0);
})();
