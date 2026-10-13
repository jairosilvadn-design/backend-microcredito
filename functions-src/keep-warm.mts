/**
 * Mantém a API e o banco "acordados" no horário de uso (07h–20h de Brasília, ou 10–23 UTC), com várias cópias da função em paralelo (KEEP_WARM_INSTANCES, padrão 4).
 * Sem isso, depois de alguns minutos parado o Netlify desliga a função e o banco dorme (Neon: 5 min),
 * e o primeiro clique leva vários segundos. Para desligar: crie a variável KEEP_WARM=off.
 */
export default async () => {
  const net = (globalThis as { Netlify?: { env?: { get(k: string): string | undefined } } }).Netlify?.env;
  const lerEnv = (k: string) => net?.get(k) || process.env[k];
  if (lerEnv('KEEP_WARM') === 'off') return new Response(JSON.stringify({ ok: true, skipped: true }));

  const site = lerEnv('URL') || (lerEnv('SITE_NAME') ? `https://${lerEnv('SITE_NAME')}.netlify.app` : 'https://microcredito-api.netlify.app');
  // Várias chamadas ao mesmo tempo: o Netlify atende uma de cada vez por cópia da função, então o painel
  // (que dispara várias requisições juntas) acorda várias cópias — e cada uma "partia a frio". Aqui deixamos N prontas.
  const n = Math.min(Math.max(Number(lerEnv('KEEP_WARM_INSTANCES')) || 4, 1), 8);
  const t0 = Date.now();
  const resultados = await Promise.allSettled(
    Array.from({ length: n }, () => fetch(`${site}/health?hold=700`, { headers: { 'user-agent': 'keep-warm' } }).then((r) => r.status)),
  );
  const ok = resultados.filter((r) => r.status === 'fulfilled' && r.value === 200).length;
  return new Response(JSON.stringify({ ok: ok > 0, copiasAcordadas: ok, de: n, ms: Date.now() - t0 }), { headers: { 'content-type': 'application/json' } });
};

export const config = { schedule: '*/4 10-23 * * *' };
