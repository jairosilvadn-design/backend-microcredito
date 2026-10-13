/**
 * Mantém a API e o banco "acordados" no horário de uso (07h–20h de Brasília, ou 10–23 UTC).
 * Sem isso, depois de alguns minutos parado o Netlify desliga a função e o banco dorme (Neon: 5 min),
 * e o primeiro clique leva vários segundos. Para desligar: crie a variável KEEP_WARM=off.
 */
export default async () => {
  const net = (globalThis as { Netlify?: { env?: { get(k: string): string | undefined } } }).Netlify?.env;
  const lerEnv = (k: string) => net?.get(k) || process.env[k];
  if (lerEnv('KEEP_WARM') === 'off') return new Response(JSON.stringify({ ok: true, skipped: true }));

  const site = lerEnv('URL') || (lerEnv('SITE_NAME') ? `https://${lerEnv('SITE_NAME')}.netlify.app` : 'https://microcredito-api.netlify.app');
  const t0 = Date.now();
  try {
    const r = await fetch(`${site}/health`, { headers: { 'user-agent': 'keep-warm' } });
    return new Response(JSON.stringify({ ok: r.ok, status: r.status, ms: Date.now() - t0 }), { headers: { 'content-type': 'application/json' } });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: String(err) }), { status: 500 });
  }
};

export const config = { schedule: '*/4 10-23 * * *' };
