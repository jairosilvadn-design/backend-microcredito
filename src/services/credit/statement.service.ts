/**
 * Leitura de extrato (opcional). Aceita CSV do internet banking e OFX.
 * O objetivo não é contabilidade: é medir entradas diárias para estimar
 * capacidade de pagamento. Quando não houver extrato, o motor de segmentos assume.
 */

export interface ParsedEntry {
  date: string;   // YYYY-MM-DD
  amount: number; // positivo = entrada
  description: string;
}

const onlyDate = (s: string): string | null => {
  const iso = s.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const br = s.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  const ofx = s.match(/^(\d{4})(\d{2})(\d{2})/);
  if (ofx) return `${ofx[1]}-${ofx[2]}-${ofx[3]}`;
  return null;
};

const toNumber = (raw: string): number | null => {
  let s = raw.trim().replace(/["\s]/g, '').replace(/R\$/i, '');
  if (!s) return null;
  const negative = /^-/.test(s) || /^\(.*\)$/.test(s);
  s = s.replace(/[()\-+]/g, '');
  // 1.234,56 (BR) ou 1234.56 (US)
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
};

export function parseOfx(text: string): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  for (const block of text.split(/<STMTTRN>/i).slice(1)) {
    const date = onlyDate((block.match(/<DTPOSTED>([^<\r\n]+)/i)?.[1] ?? '').trim());
    const amount = toNumber(block.match(/<TRNAMT>([^<\r\n]+)/i)?.[1] ?? '');
    const desc = (block.match(/<MEMO>([^<\r\n]+)/i)?.[1] ?? block.match(/<NAME>([^<\r\n]+)/i)?.[1] ?? '').trim();
    if (date && amount != null) out.push({ date, amount, description: desc.slice(0, 120) });
  }
  return out;
}

export function parseCsv(text: string): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = line.split(line.includes(';') ? ';' : ',');
    if (cols.length < 2) continue;
    const date = onlyDate(cols[0] ?? '');
    if (!date) continue; // cabeçalho ou linha de saldo
    // o valor é a última coluna numérica da linha
    let amount: number | null = null;
    for (let c = cols.length - 1; c >= 1; c--) {
      const n = toNumber(cols[c] ?? '');
      if (n != null && n !== 0) { amount = n; break; }
    }
    if (amount == null) continue;
    out.push({ date, amount, description: (cols[1] ?? '').trim().slice(0, 120) });
  }
  return out;
}

export function parseStatement(fileName: string, text: string): { entries: ParsedEntry[]; source: 'OFX' | 'CSV' } {
  const isOfx = /\.ofx$/i.test(fileName) || /<STMTTRN>/i.test(text);
  return isOfx ? { entries: parseOfx(text), source: 'OFX' } : { entries: parseCsv(text), source: 'CSV' };
}

export interface StatementSummary {
  periodFrom: string;
  periodTo: string;
  days: number;
  creditsTotal: number;
  debitsTotal: number;
  creditsCount: number;
  daysWithCredit: number;
  avgDailyCredits: number;
  medianDaily: number;
  biggestCredit: number;
  weekdayAverages: number[];
  warnings: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function summarize(entries: ParsedEntry[]): StatementSummary {
  const warnings: string[] = [];
  if (!entries.length) {
    return { periodFrom: '', periodTo: '', days: 0, creditsTotal: 0, debitsTotal: 0, creditsCount: 0, daysWithCredit: 0, avgDailyCredits: 0, medianDaily: 0, biggestCredit: 0, weekdayAverages: Array(7).fill(0), warnings: ['Nenhum lançamento reconhecido no arquivo.'] };
  }

  const dates = entries.map((e) => e.date).sort();
  const periodFrom = dates[0]!, periodTo = dates[dates.length - 1]!;
  const days = Math.max(1, Math.round((Date.parse(`${periodTo}T12:00:00Z`) - Date.parse(`${periodFrom}T12:00:00Z`)) / 86400_000) + 1);

  const daily = new Map<string, number>();
  const weekdaySum = Array(7).fill(0);
  const weekdayDays = Array(7).fill(0);
  let creditsTotal = 0, debitsTotal = 0, creditsCount = 0, biggest = 0;

  for (const e of entries) {
    if (e.amount > 0) {
      creditsTotal += e.amount;
      creditsCount++;
      biggest = Math.max(biggest, e.amount);
      daily.set(e.date, (daily.get(e.date) ?? 0) + e.amount);
    } else debitsTotal += Math.abs(e.amount);
  }

  for (const [d, v] of daily) {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
    weekdaySum[dow] += v;
    weekdayDays[dow]++;
  }

  const values: number[] = [];
  for (let d = periodFrom; d <= periodTo; d = new Date(Date.parse(`${d}T12:00:00Z`) + 86400_000).toISOString().slice(0, 10)) {
    values.push(daily.get(d) ?? 0);
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid]! : ((sorted[mid - 1]! + sorted[mid]!) / 2);

  if (days < 30) warnings.push('Período menor que 30 dias: a média pode não representar um mês típico.');
  if (biggest > creditsTotal * 0.4 && creditsCount > 1) warnings.push('Uma única entrada representa grande parte do total; confira se não é empréstimo ou transferência própria.');

  return {
    periodFrom, periodTo, days,
    creditsTotal: round2(creditsTotal),
    debitsTotal: round2(debitsTotal),
    creditsCount,
    daysWithCredit: daily.size,
    avgDailyCredits: round2(creditsTotal / days),
    medianDaily: round2(median),
    biggestCredit: round2(biggest),
    weekdayAverages: weekdaySum.map((s, i) => round2(weekdayDays[i] ? s / weekdayDays[i]! : 0)),
    warnings,
  };
}
