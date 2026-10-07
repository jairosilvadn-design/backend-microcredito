/**
 * Banco do Netlify (Neon) entrega NETLIFY_DATABASE_URL (com pooler) e NETLIFY_DATABASE_URL_UNPOOLED.
 * O Prisma lê DATABASE_URL / DIRECT_URL; aqui ligamos uma coisa na outra, sem exigir cópia manual.
 * Com DATABASE_URL já definido (ex.: Supabase), nada muda.
 */
export function ligarBanco() {
  const e = process.env;
  const pooled = e.DATABASE_URL || e.NETLIFY_DATABASE_URL;
  const direto = e.DIRECT_URL || e.NETLIFY_DATABASE_URL_UNPOOLED || pooled;
  if (pooled) {
    // Pooler (pgbouncer) exige este parâmetro no Prisma; função serverless: 1 conexão por instância.
    const u = new URL(pooled);
    if (/pooler/.test(u.hostname) || u.port === '6543') {
      if (!u.searchParams.has('pgbouncer')) u.searchParams.set('pgbouncer', 'true');
    }
    if (!u.searchParams.has('connection_limit')) u.searchParams.set('connection_limit', '3');
    e.DATABASE_URL = u.toString();
  }
  if (direto) e.DIRECT_URL = direto;
}
