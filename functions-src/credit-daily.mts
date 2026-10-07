import { copiarVariaveis, ligarBanco } from './_db-env';

/** Régua diária do crédito: 07:00 em São Paulo (UTC-3) = 10:00 UTC. */
export default async () => {
  copiarVariaveis(['NODE_ENV', 'FIREBASE_PROJECT_ID', 'CORS_ORIGINS', 'TOKEN_ENC_KEYS', 'TOKEN_ENC_ACTIVE_KID', 'APP_PUBLIC_URL', 'PIX_DEFAULT_PAYER_EMAIL']);
  ligarBanco();
  const { runCreditDaily } = await import('../src/jobs/credit-daily.job');
  const log = (await import('pino')).default({ level: 'info' });
  const stats = await runCreditDaily(log as never);
  return new Response(JSON.stringify({ ok: stats !== null, stats }), { headers: { 'content-type': 'application/json' } });
};

export const config = { schedule: '0 10 * * *' };
