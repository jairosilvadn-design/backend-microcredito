import { ligarBanco } from './_db-env';
ligarBanco();

/** Régua diária do crédito: 07:00 em São Paulo (UTC-3) = 10:00 UTC. */
export default async () => {
  const { runCreditDaily } = await import('../../src/jobs/credit-daily.job');
  const log = (await import('pino')).default({ level: 'info' });
  const stats = await runCreditDaily(log as never);
  return new Response(JSON.stringify({ ok: stats !== null, stats }), { headers: { 'content-type': 'application/json' } });
};

export const config = { schedule: '0 10 * * *' };
