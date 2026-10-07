/** Chama a Netlify Function (formato Request/Response) contra um Postgres local. */
import './setup-env';
process.env.NETLIFY_DB_URL = process.env.DB_TEST_URL ?? '';
delete process.env.DATABASE_URL;
let pass = 0, fail = 0;
const check = (n: string, c: boolean, x = '') => { c ? pass++ : fail++; console.log(`${c ? '✔' : '✘'} ${n}${c ? '' : ' ' + x}`); };
const req = (path: string, method = 'GET', headers: Record<string, string> = {}) => new Request(`https://x.netlify.app${path}`, { method, headers });
(async () => {
  const { default: api } = await import('../netlify/functions/api.mjs');
  const h = await api(req('/health'));
  const hb = await h.text();
  check(`/health responde 200 e fala com o banco (${hb})`, h.status === 200 && /ok/.test(hb), String(h.status));
  check('rota protegida sem login devolve 401', (await api(req('/api/credito/painel'))).status === 401);
  const c = await api(req('/api/credito/painel', 'OPTIONS', { origin: 'https://test.local', 'access-control-request-method': 'GET' }));
  check('CORS libera a origem do painel', c.status === 204 && c.headers.get('access-control-allow-origin') === 'https://test.local');
  check('link público de assinatura inválido devolve 410 (sem login)', (await api(req('/p/contrato/' + 'x'.repeat(30)))).status === 410);
  const post = await api(new Request('https://x.netlify.app/api/credito/config', { method: 'PUT', body: '{}', headers: { 'content-type': 'application/json' } }));
  check('PUT com corpo chega na API (401 sem login)', post.status === 401);
  const { default: job } = await import('../netlify/functions/credit-daily.mjs');
  check('tarefa diária executa', (await (await job()).json()).ok === true);
  console.log(`\n${pass} passaram, ${fail} falharam`); process.exit(fail ? 1 : 0);
})();
