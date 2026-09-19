/**
 * Datas no fuso America/Sao_Paulo (UTC-3 fixo desde o fim do horário de verão em 2019).
 * Convenção do projeto: dias de referência trafegam como string "YYYY-MM-DD".
 */
const TZ = 'America/Sao_Paulo';
const OFFSET_MS = 3 * 3600_000;

/** Formato aceito pela API do Mercado Pago, com offset -03:00. */
export function toMpDate(d: Date): string {
  return new Date(d.getTime() - OFFSET_MS).toISOString().replace('Z', '-03:00');
}

/** Dia corrente (ou de uma data) em São Paulo, "YYYY-MM-DD". */
export function ymdSaoPaulo(d: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
}

export function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Lista inclusiva de dias entre from e to. */
export function ymdRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDaysYmd(d, 1)) out.push(d);
  return out;
}

/** Valor para colunas @db.Date do Prisma. */
export const ymdToDbDate = (ymd: string) => new Date(`${ymd}T00:00:00.000Z`);
export const dbDateToYmd = (d: Date) => d.toISOString().slice(0, 10);
export const todayDbDate = () => ymdToDbDate(ymdSaoPaulo());

/** Início (inclusivo) e fim (exclusivo) do dia em São Paulo, como instantes UTC. */
export function dayBoundsSaoPaulo(ymd: string): { start: Date; end: Date } {
  const start = new Date(new Date(`${ymd}T00:00:00.000Z`).getTime() + OFFSET_MS);
  return { start, end: new Date(start.getTime() + 86400_000) };
}

export const isValidYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
