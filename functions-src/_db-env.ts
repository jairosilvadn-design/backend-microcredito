/**
 * Banco do Netlify (Neon): a conexão chega em NETLIFY_DB_URL, lida via `Netlify.env` (runtime do Netlify)
 * ou process.env (build/local). O Prisma lê DATABASE_URL / DIRECT_URL; aqui ligamos uma coisa na outra.
 * Com DATABASE_URL já definido (ex.: Supabase), nada muda.
 */
function lerEnv(nome: string): string | undefined {
  const viaNetlify = (globalThis as { Netlify?: { env?: { get(k: string): string | undefined } } }).Netlify?.env?.get(nome);
  return viaNetlify || process.env[nome] || undefined;
}

export function ligarBanco() {
  const e = process.env;
  const pooled = lerEnv('DATABASE_URL') || lerEnv('NETLIFY_DB_URL') || lerEnv('NETLIFY_DATABASE_URL');
  const direto = lerEnv('DIRECT_URL') || lerEnv('NETLIFY_DATABASE_URL_UNPOOLED') || pooled;
  if (pooled) {
    const u = new URL(pooled);
    // Pooler (pgbouncer) exige este parâmetro no Prisma; função serverless: poucas conexões por instância.
    if (/pooler/.test(u.hostname) || u.port === '6543') {
      if (!u.searchParams.has('pgbouncer')) u.searchParams.set('pgbouncer', 'true');
    }
    if (!u.searchParams.has('connection_limit')) u.searchParams.set('connection_limit', '3');
    e.DATABASE_URL = u.toString();
  }
  if (direto) e.DIRECT_URL = direto;
}

/** Copia as demais variáveis do Netlify.env para process.env (o app lê process.env). */
export function copiarVariaveis(nomes: string[]) {
  for (const n of nomes) {
    if (!process.env[n]) {
      const v = lerEnv(n);
      if (v) process.env[n] = v;
    }
  }
}
