import { Prisma } from '@prisma/client';
import { addDaysYmd, ymdSaoPaulo } from '../../lib/dates';

/** Cronograma e preço do ciclo de crédito. Funções puras: sem banco, sem rede. */

export type Frequency = 'DAILY' | 'WEEKLY';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Datas de vencimento. No diário, pula domingo (e sábado, se a loja não abrir). */
export function buildSchedule(firstDueYmd: string, count: number, frequency: Frequency, openDaysPerWeek = 6): string[] {
  const skipSunday = openDaysPerWeek <= 6;
  const skipSaturday = openDaysPerWeek <= 5;
  const out: string[] = [];
  let d = firstDueYmd;

  while (out.length < count) {
    const dow = new Date(`${d}T12:00:00Z`).getUTCDay(); // 0 = domingo, 6 = sábado
    const blocked = frequency === 'DAILY' && ((skipSunday && dow === 0) || (skipSaturday && dow === 6));
    if (!blocked) out.push(d);
    d = addDaysYmd(d, frequency === 'DAILY' ? 1 : 7);
  }
  return out;
}

/** Parcelas iguais; a última absorve os centavos que sobram. */
export function splitAmounts(total: number, count: number): number[] {
  const base = Math.floor((total / count) * 100) / 100;
  const list = Array.from({ length: count }, () => base);
  list[count - 1] = round2(total - base * (count - 1));
  return list;
}

/**
 * Custo Efetivo Total ao mês: taxa que zera o fluxo de caixa (TIR).
 * O cliente recebe o principal hoje e devolve as parcelas nas datas do cronograma.
 * Calculada por bisseção — não depende de biblioteca externa.
 */
export function cetMonthly(principal: number, dueDates: string[], amounts: number[], startYmd = ymdSaoPaulo()): number {
  const t0 = Date.parse(`${startYmd}T12:00:00Z`);
  const days = dueDates.map((d) => Math.max(1, Math.round((Date.parse(`${d}T12:00:00Z`) - t0) / 86400_000)));

  const npv = (dailyRate: number) =>
    amounts.reduce((acc, a, i) => acc + a / (1 + dailyRate) ** days[i]!, 0) - principal;

  let low = 0, high = 1; // 0% a 100% ao dia
  if (npv(low) <= 0) return 0;
  for (let k = 0; k < 200; k++) {
    const mid = (low + high) / 2;
    if (npv(mid) > 0) low = mid; else high = mid;
  }
  const daily = (low + high) / 2;
  return Math.round(((1 + daily) ** 30 - 1) * 10000) / 10000; // ao mês, 4 casas
}

/**
 * CUSTOS DA OPERAÇÃO — no padrão de um contrato bancário.
 *
 * IOF: as alíquotas são parâmetro do sistema, não estão travadas no código,
 * porque mudam por decreto e dependem do enquadramento da operação (inclusive
 * se ela é ou não fato gerador). Confirme com o seu contador antes de ligar.
 *
 * Dois modos:
 *   DEDUZIR    — o custo sai do valor entregue (o cliente contrata 300 e recebe 295)
 *   FINANCIAR  — o custo entra no saldo devedor (recebe 300 e devolve mais)
 */
export interface CostInput {
  principal: number;
  termDays: number;
  chargeIof: boolean;
  iofFixedPercent: number;
  iofDailyPercent: number;
  tacFixed: number;
  tacPercent: number;
  otherCosts: number;
  costsMode: 'DEDUZIR' | 'FINANCIAR';
}

export interface CostBreakdown {
  iof: number;
  tac: number;
  other: number;
  total: number;
  mode: 'DEDUZIR' | 'FINANCIAR';
  netToBorrower: number;   // quanto cai na conta do cliente
  financedAmount: number;  // sobre quanto os juros incidem
  lines: Array<{ label: string; value: number }>;
}

export function computeCosts(i: CostInput): CostBreakdown {
  const dias = Math.min(365, Math.max(1, i.termDays));
  const iof = i.chargeIof
    ? round2(i.principal * (i.iofFixedPercent / 100) + i.principal * (i.iofDailyPercent / 100) * dias)
    : 0;
  const tac = round2(i.tacFixed + i.principal * (i.tacPercent / 100));
  const other = round2(i.otherCosts);
  const total = round2(iof + tac + other);

  const netToBorrower = i.costsMode === 'DEDUZIR' ? round2(i.principal - total) : round2(i.principal);
  const financedAmount = i.costsMode === 'DEDUZIR' ? round2(i.principal) : round2(i.principal + total);

  const lines = [
    { label: 'Valor contratado', value: round2(i.principal) },
    ...(iof ? [{ label: `IOF (${i.iofFixedPercent}% + ${i.iofDailyPercent}% ao dia por ${dias} dias)`, value: iof }] : []),
    ...(tac ? [{ label: 'Tarifa de cadastro', value: tac }] : []),
    ...(other ? [{ label: 'Outros custos (registro e documentação)', value: other }] : []),
    { label: i.costsMode === 'DEDUZIR' ? 'Valor líquido entregue ao cliente' : 'Valor entregue ao cliente', value: netToBorrower },
  ];

  return { iof, tac, other, total, mode: i.costsMode, netToBorrower, financedAmount, lines };
}

export interface QuoteInput {
  principal: number;
  ratePercent: number;       // % sobre o principal no ciclo
  installments: number;
  frequency: Frequency;
  firstDueDate: string;
  openDaysPerWeek?: number;
  costs?: CostBreakdown;     // quando houver IOF/tarifas
  /**
   * Cronograma combinado com o cliente, parcela a parcela.
   * Quando vem preenchido, manda nele: as datas e os valores são os acertados
   * na conversa, e não os gerados automaticamente. É o caso de "me paga 50 na
   * sexta e 30 na quarta", ou de misturar dias e semanas no mesmo contrato.
   */
  cronograma?: Array<{ dueDate: string; amount: number }>;
}

export interface Quote {
  principal: number;
  costs: CostBreakdown | null;
  netToBorrower: number;
  ratePercent: number;
  totalPayable: number;
  interest: number;
  installments: number;
  installmentAmount: number;
  lastInstallmentAmount: number;
  frequency: Frequency;
  /** true quando as datas e valores foram acertados à mão com o cliente. */
  combinado: boolean;
  dueDates: string[];
  amounts: number[];
  firstDueDate: string;
  lastDueDate: string;
  cetMonthly: number;        // 0.15 = 15% a.m.
  cetLabel: string;
}

export function quote(i: QuoteInput): Quote {
  const base = i.costs ? i.costs.financedAmount : i.principal;
  const combinado = i.cronograma?.length ? [...i.cronograma].sort((a, b) => a.dueDate.localeCompare(b.dueDate)) : null;

  const total = combinado
    ? round2(combinado.reduce((soma, p) => soma + p.amount, 0))
    : round2(base * (1 + i.ratePercent / 100));
  const dueDates = combinado ? combinado.map((p) => p.dueDate) : buildSchedule(i.firstDueDate, i.installments, i.frequency, i.openDaysPerWeek ?? 6);
  const amounts = combinado ? combinado.map((p) => round2(p.amount)) : splitAmounts(total, i.installments);
  // O CET é calculado sobre o que o cliente REALMENTE recebe: é assim que o
  // custo das tarifas aparece na taxa, como exige a regra dos bancos.
  const liquido = i.costs ? i.costs.netToBorrower : i.principal;
  const cet = cetMonthly(liquido, dueDates, amounts);

  return {
    principal: round2(i.principal),
    costs: i.costs ?? null,
    netToBorrower: round2(liquido),
    ratePercent: i.ratePercent,
    totalPayable: total,
    interest: round2(total - i.principal),
    installments: amounts.length,
    installmentAmount: amounts[0]!,
    lastInstallmentAmount: amounts[amounts.length - 1]!,
    frequency: i.frequency,
    combinado: Boolean(combinado),
    dueDates,
    amounts,
    firstDueDate: dueDates[0]!,
    lastDueDate: dueDates[dueDates.length - 1]!,
    cetMonthly: cet,
    cetLabel: `${(cet * 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}% ao mês`,
  };
}

/** Encargos de atraso: multa (uma vez) + juros de mora por dia. */
export function lateCharge(amountDue: Prisma.Decimal, lateDays: number, feePercent: Prisma.Decimal, dailyPercent: Prisma.Decimal): Prisma.Decimal {
  if (lateDays <= 0) return new Prisma.Decimal(0);
  const fee = amountDue.mul(feePercent).div(100);
  const interest = amountDue.mul(dailyPercent).div(100).mul(lateDays);
  return fee.plus(interest).toDecimalPlaces(2);
}
