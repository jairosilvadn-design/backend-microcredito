import { Prisma } from '@prisma/client';

/**
 * MOTOR DE CAPACIDADE DE PAGAMENTO
 *
 * O público-alvo é comércio de caixa diário, que muitas vezes não tem extrato
 * bancário nenhum. Então a capacidade é estimada por três caminhos, e o sistema
 * sempre usa o MENOR deles (o mais conservador):
 *
 *   1. Tabela de segmento  — faturamento diário típico do ramo, na faixa de
 *      bairro, multiplicado pelo % do caixa que pode ser comprometido.
 *   2. Faturamento declarado — o que o próprio comerciante informa, ajustado
 *      por um redutor de prudência (declarações costumam ser otimistas).
 *   3. Extrato (quando houver) — média diária real de entradas.
 *
 * Nenhum número aqui é "achismo de máquina": são parâmetros editáveis no painel,
 * e a sugestão final é sempre uma recomendação ao operador, não uma aprovação.
 */

export interface Segment {
  key: string;
  label: string;
  /** Faixa de faturamento diário típico de um ponto de bairro (R$). */
  dailyLow: number;
  dailyTypical: number;
  /** % do caixa diário que o negócio aguenta comprometer sem sufocar. */
  commitment: number;
  /** Dias de funcionamento por semana, padrão do ramo. */
  openDays: number;
  /** Peso de risco: 1 = estável; acima disso, receita mais volátil. */
  volatility: number;
  hint: string;
}

export const SEGMENTS: Segment[] = [
  { key: 'mercearia', label: 'Mercearia / mercadinho', dailyLow: 300, dailyTypical: 700, commitment: 0.10, openDays: 7, volatility: 1.0, hint: 'Fluxo diário constante e previsível.' },
  { key: 'lanchonete', label: 'Lanchonete / pastelaria', dailyLow: 250, dailyTypical: 600, commitment: 0.10, openDays: 6, volatility: 1.1, hint: 'Boa margem, mas sensível a chuva e feriado.' },
  { key: 'bar', label: 'Bar / distribuidora', dailyLow: 250, dailyTypical: 700, commitment: 0.09, openDays: 6, volatility: 1.2, hint: 'Concentra faturamento no fim de semana.' },
  { key: 'padaria', label: 'Padaria', dailyLow: 400, dailyTypical: 900, commitment: 0.10, openDays: 7, volatility: 0.9, hint: 'O fluxo mais regular do comércio de bairro.' },
  { key: 'salao', label: 'Salão / barbearia', dailyLow: 150, dailyTypical: 350, commitment: 0.12, openDays: 6, volatility: 1.2, hint: 'Custo baixo, mas agenda oscila na semana.' },
  { key: 'hortifruti', label: 'Hortifrúti / feira', dailyLow: 250, dailyTypical: 600, commitment: 0.09, openDays: 6, volatility: 1.2, hint: 'Perecível: prejuízo se a semana for fraca.' },
  { key: 'roupas', label: 'Loja de roupas / calçados', dailyLow: 150, dailyTypical: 450, commitment: 0.08, openDays: 6, volatility: 1.4, hint: 'Venda irregular e muito sazonal.' },
  { key: 'pet', label: 'Pet shop', dailyLow: 200, dailyTypical: 450, commitment: 0.10, openDays: 6, volatility: 1.1, hint: 'Mistura serviço recorrente e produto.' },
  { key: 'ambulante', label: 'Ambulante / food truck', dailyLow: 120, dailyTypical: 300, commitment: 0.12, openDays: 6, volatility: 1.5, hint: 'Caixa no dia, mas sem ponto fixo como garantia.' },
  { key: 'servicos', label: 'Serviços (costura, chaveiro, oficina)', dailyLow: 120, dailyTypical: 350, commitment: 0.10, openDays: 6, volatility: 1.3, hint: 'Recebimento por serviço concluído.' },
  { key: 'outro', label: 'Outro comércio', dailyLow: 150, dailyTypical: 350, commitment: 0.08, openDays: 6, volatility: 1.4, hint: 'Sem referência de ramo: margem reduzida.' },
];

export const getSegment = (key: string): Segment =>
  SEGMENTS.find((s) => s.key === key) ?? SEGMENTS[SEGMENTS.length - 1]!;

/** Redutor aplicado ao faturamento que o próprio comerciante declara. */
const DECLARED_HAIRCUT = 0.7;

export interface CapacityInput {
  segment: string;
  openDaysPerWeek: number;
  businessMonths: number;
  declaredDailySales?: number | null;
  statementDailyAverage?: number | null; // do extrato, quando houver
  ownsPoint?: boolean;
  referred?: boolean;
  hasDocuments?: boolean;
}

export interface CapacityResult {
  dailyCapacity: number;      // quanto ele aguenta pagar por dia
  weeklyCapacity: number;
  basis: string;              // de onde veio o número
  estimatedDailySales: number;
  score: number;              // 0 a 100
  scoreLabel: 'BAIXO' | 'MEDIO' | 'ALTO';
  factors: string[];          // explicação linha a linha
  warnings: string[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/**
 * Score de 0 a 100. Serve para ajustar o limite dentro do nível e para dar ao
 * operador uma leitura rápida do risco — nunca para aprovar sozinho.
 */
export function scoreBorrower(i: CapacityInput): { score: number; factors: string[] } {
  const seg = getSegment(i.segment);
  const factors: string[] = [];
  let score = 40; // base neutra

  if (i.businessMonths >= 36) { score += 20; factors.push('Negócio com mais de 3 anos (+20).'); }
  else if (i.businessMonths >= 12) { score += 12; factors.push('Negócio com mais de 1 ano (+12).'); }
  else if (i.businessMonths >= 6) { score += 5; factors.push('Entre 6 e 12 meses de atividade (+5).'); }
  else { score -= 10; factors.push('Menos de 6 meses de atividade (-10).'); }

  if (i.openDaysPerWeek >= 6) { score += 8; factors.push('Abre 6 ou 7 dias por semana (+8).'); }
  else if (i.openDaysPerWeek <= 4) { score -= 6; factors.push('Abre 4 dias ou menos por semana (-6).'); }

  if (seg.volatility <= 1.0) { score += 8; factors.push(`${seg.label}: fluxo de caixa estável (+8).`); }
  else if (seg.volatility >= 1.4) { score -= 8; factors.push(`${seg.label}: faturamento irregular (-8).`); }

  if (i.ownsPoint) { score += 8; factors.push('Ponto próprio (+8).'); }
  if (i.referred) { score += 5; factors.push('Indicado por cliente da carteira (+5).'); }
  if (i.hasDocuments) { score += 5; factors.push('Documentos enviados e conferidos (+5).'); }
  if (i.statementDailyAverage != null) { score += 10; factors.push('Extrato analisado (+10).'); }

  return { score: Math.round(clamp(score, 0, 100)), factors };
}

export function estimateCapacity(i: CapacityInput): CapacityResult {
  const seg = getSegment(i.segment);
  const warnings: string[] = [];
  const candidates: Array<{ value: number; basis: string; sales: number }> = [];

  // 1) Tabela do segmento — usa a base BAIXA da faixa, não a típica.
  const segSales = seg.dailyLow;
  candidates.push({ value: segSales * seg.commitment, basis: `tabela do ramo (${seg.label})`, sales: segSales });

  // 2) Declarado pelo comerciante, com redutor de prudência.
  if (i.declaredDailySales && i.declaredDailySales > 0) {
    const sales = i.declaredDailySales * DECLARED_HAIRCUT;
    candidates.push({ value: sales * seg.commitment, basis: 'faturamento declarado (com redutor de 30%)', sales });
    if (i.declaredDailySales > seg.dailyTypical * 2.5) {
      warnings.push(`O faturamento declarado está muito acima do típico do ramo (${seg.label}). Confirme antes de liberar.`);
    }
  } else {
    warnings.push('Sem faturamento declarado: a estimativa usa só a tabela do ramo.');
  }

  // 3) Extrato, quando houver.
  if (i.statementDailyAverage && i.statementDailyAverage > 0) {
    candidates.push({ value: i.statementDailyAverage * seg.commitment, basis: 'extrato analisado', sales: i.statementDailyAverage });
  }

  const chosen = candidates.reduce((a, b) => (a.value <= b.value ? a : b));
  const { score, factors } = scoreBorrower(i);

  // Ajuste fino pelo score: entre 80% e 110% da capacidade calculada.
  const scoreFactor = 0.8 + (score / 100) * 0.3;
  const daily = round2(chosen.value * scoreFactor);

  // Só cobra nos dias em que a loja abre.
  const weekly = round2(daily * Math.max(1, Math.min(7, i.openDaysPerWeek)));

  if (i.businessMonths < 6) warnings.push('Negócio recente: comece pelo menor ticket possível.');

  return {
    dailyCapacity: daily,
    weeklyCapacity: weekly,
    basis: chosen.basis,
    estimatedDailySales: round2(chosen.sales),
    score,
    scoreLabel: score >= 70 ? 'ALTO' : score >= 45 ? 'MEDIO' : 'BAIXO',
    factors,
    warnings,
  };
}

/**
 * Valor que cabe no bolso dele: parcela suportável × prazo, descontada a taxa.
 * O limite do nível continua sendo o teto absoluto.
 */
export function suggestPrincipal(params: {
  capacity: CapacityResult;
  frequency: 'DAILY' | 'WEEKLY';
  installments: number;
  ratePercent: number;
  levelMax: number;
}): { principal: number; installmentAmount: number; cappedByLevel: boolean } {
  const perInstallment = params.frequency === 'DAILY' ? params.capacity.dailyCapacity : params.capacity.weeklyCapacity;
  const total = perInstallment * params.installments;
  const raw = total / (1 + params.ratePercent / 100);

  // Arredonda para baixo em múltiplos de R$ 50 (fica claro para o cliente).
  const rounded = Math.floor(raw / 50) * 50;
  const principal = Math.max(0, Math.min(rounded, params.levelMax));

  return {
    principal,
    installmentAmount: round2(perInstallment),
    cappedByLevel: rounded > params.levelMax,
  };
}

export const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
