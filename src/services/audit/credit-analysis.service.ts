import { addDaysYmd, dayBoundsSaoPaulo, ymdRange, ymdSaoPaulo } from '../../lib/dates';
import type { MpPayment } from '../mercadopago/types';
import { isSale } from './payment-classifier';

/**
 * ANÁLISE DE VENDAS PARA CONCESSÃO DE CRÉDITO — função pura (sem banco, sem rede).
 *
 * Tudo aqui é SUGESTÃO para apoiar a decisão do operador, nunca uma decisão automática.
 * Limitação: só enxerga a conta Mercado Pago do comerciante. Vendas em outras
 * maquininhas ou contas bancárias não aparecem.
 */
export interface AnalysisOptions {
  fromYmd: string;
  toYmd: string;
  merchantMpUserId: bigint | null;
  splitPercent: number; // retenção pretendida por venda (%)
  termDays: number;     // nº de parcelas pretendido
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function median(values: number[]): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function mondayOf(ymd: string): string {
  const dow = new Date(`${ymd}T12:00:00Z`).getUTCDay(); // 0 = domingo
  return addDaysYmd(ymd, dow === 0 ? -6 : 1 - dow);
}

const METODO: Record<string, string> = {
  bank_transfer: 'Pix',
  credit_card: 'Cartão de crédito',
  debit_card: 'Cartão de débito',
  prepaid_card: 'Cartão pré-pago',
  account_money: 'Saldo Mercado Pago',
  ticket: 'Boleto',
};

export function summarizeSales(payments: MpPayment[], o: AnalysisOptions) {
  const days = ymdRange(o.fromYmd, o.toYmd);
  const daily = new Map(days.map((d) => [d, 0]));
  const weekly = new Map<string, number>();
  const byMethod = new Map<string, { count: number; amount: number }>();
  const byWeekday = Array.from({ length: 7 }, () => 0);

  let total = 0, count = 0, refunds = 0, pointCount = 0;

  for (const p of payments) {
    const when = p.date_approved ?? p.date_created;
    const ymd = ymdSaoPaulo(new Date(when));
    if (!daily.has(ymd)) continue;

    if (p.status === 'refunded' || p.status === 'charged_back') { refunds++; continue; }
    if (!isSale(p, o.merchantMpUserId)) continue;

    const v = Number(p.transaction_amount) || 0;
    total += v;
    count++;
    daily.set(ymd, daily.get(ymd)! + v);
    const w = mondayOf(ymd);
    weekly.set(w, (weekly.get(w) ?? 0) + v);
    const dow = new Date(`${ymd}T12:00:00Z`).getUTCDay();
    byWeekday[dow] = (byWeekday[dow] ?? 0) + v;

    const metodo = METODO[p.payment_type_id ?? ''] ?? 'Outros';
    const m = byMethod.get(metodo) ?? { count: 0, amount: 0 };
    m.count++; m.amount += v;
    byMethod.set(metodo, m);

    if (p.operation_type === 'pos_payment' || /point/i.test(p.point_of_interaction?.type ?? '')) pointCount++;
  }

  const dailyValues = days.map((d) => daily.get(d)!);
  const activeDays = dailyValues.filter((v) => v > 0).length;
  const mean = days.length ? total / days.length : 0;
  const med = median(dailyValues);
  const activeRatio = days.length ? activeDays / days.length : 0;
  const refundRate = count + refunds ? refunds / (count + refunds) : 0;

  // Tendência: média diária da metade recente vs. metade anterior
  const half = Math.floor(days.length / 2);
  const older = dailyValues.slice(0, half);
  const recent = dailyValues.slice(half);
  const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
  const trend = avg(older) > 0 ? (avg(recent) - avg(older)) / avg(older) : null;

  // Sugestão conservadora: usa a MEDIANA diária (não a média), que não é inflada por
  // um ou dois dias excepcionais. Quem vende em poucos dias usa 70% da média.
  let baseDaily = med;
  const notes: string[] = [];
  if (med === 0 && mean > 0) {
    baseDaily = mean * 0.7;
    notes.push('O comerciante não vende todos os dias; a sugestão usa 70% da média diária.');
  }
  const installment = round2(baseDaily * (o.splitPercent / 100));
  const suggestedTotal = round2(installment * o.termDays);

  // Nível de confiança com motivos explícitos
  const reasons: string[] = [];
  let score = 0;
  if (activeRatio >= 0.7) { score += 2; reasons.push(`Vende em ${Math.round(activeRatio * 100)}% dos dias (regular).`); }
  else if (activeRatio >= 0.4) { score += 1; reasons.push(`Vende em ${Math.round(activeRatio * 100)}% dos dias (irregular).`); }
  else reasons.push(`Vende em apenas ${Math.round(activeRatio * 100)}% dos dias.`);

  if (refundRate < 0.03) { score += 1; reasons.push(`Poucos estornos (${(refundRate * 100).toFixed(1)}%).`); }
  else reasons.push(`Estornos elevados (${(refundRate * 100).toFixed(1)}%).`);

  if (trend === null) reasons.push('Sem histórico suficiente para medir tendência.');
  else if (trend >= -0.15) { score += 1; reasons.push(`Vendas ${trend >= 0 ? 'estáveis ou crescendo' : 'levemente em queda'} (${trend >= 0 ? '+' : ''}${Math.round(trend * 100)}%).`); }
  else reasons.push(`Vendas em queda (${Math.round(trend * 100)}%).`);

  if (count < 30) reasons.push(`Poucas vendas no período (${count}); o histórico é curto para conclusões firmes.`);

  const confidence = count < 30 ? 'BAIXA' : score >= 4 ? 'ALTA' : score >= 2 ? 'MÉDIA' : 'BAIXA';

  return {
    period: { from: o.fromYmd, to: o.toYmd, days: days.length },
    totals: {
      sales: round2(total),
      count,
      averageTicket: count ? round2(total / count) : 0,
      dailyMean: round2(mean),
      dailyMedian: round2(med),
      activeDays,
      activeRatio: round2(activeRatio),
      refunds,
      refundRate: round2(refundRate),
      trend: trend === null ? null : round2(trend),
      pointSalesCount: pointCount,
    },
    weekly: [...weekly.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([weekStart, amount]) => ({ weekStart, amount: round2(amount) })),
    byWeekday: byWeekday.map((v) => round2(v)), // 0 = domingo
    byMethod: [...byMethod.entries()].map(([method, m]) => ({ method, count: m.count, amount: round2(m.amount) })).sort((a, b) => b.amount - a.amount),
    suggestion: {
      splitPercent: o.splitPercent,
      termDays: o.termDays,
      dailyInstallment: installment,
      totalPayable: suggestedTotal,
      confidence,
      reasons,
      notes,
    },
  };
}

/** Período padrão: termina ontem (dia completo) e volta N dias. */
export function analysisPeriod(days: number) {
  const toYmd = addDaysYmd(ymdSaoPaulo(), -1);
  const fromYmd = addDaysYmd(toYmd, -(days - 1));
  return { fromYmd, toYmd, begin: dayBoundsSaoPaulo(fromYmd).start, end: new Date(dayBoundsSaoPaulo(toYmd).end.getTime() - 1) };
}
