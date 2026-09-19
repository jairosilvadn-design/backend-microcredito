import { Prisma } from '@prisma/client';

/**
 * MOTOR DE REGRAS — função pura, sem banco e sem rede (100% testável).
 *
 * VERDE    O que foi retido no dia atingiu a parcela do dia e não houve desvio.
 * AMARELO  Dia de parcela com retenção abaixo da meta (faturou pouco ou zerou o QR),
 *          OU um dia isolado com vendas fora do split (desvio pontual, ainda não é infração).
 * VERMELHO Vendas fora do split por N dias seguidos (N = graceDaysForBreach do contrato, padrão 2).
 *
 * Regras do contador de dias seguidos:
 *  - Dia com desvio (vendas fora do split acima da tolerância): +1.
 *  - Dia com vendas, todas pelo split (ou desvio abaixo da tolerância): zera.
 *  - Dia SEM nenhuma venda (loja fechada): neutro, mantém o contador.
 *    Sem isso, bastaria fechar a loja um dia entre dois desvios para escapar da regra.
 *  - Extrato indisponível (API fora, token revogado): neutro, e o dia fica anotado.
 */
export type DailyStatusValue = 'GREEN' | 'YELLOW' | 'RED';

export interface RuleInput {
  isDueDay: boolean;
  dailyTarget: Prisma.Decimal;
  retained: Prisma.Decimal;
  totalSales: Prisma.Decimal;
  nonSplitSales: Prisma.Decimal;
  nonSplitCount: number;
  prevConsecutive: number;
  graceDays: number;
  syncOk: boolean;
  bypassMinAmount: Prisma.Decimal;
  bypassMinCount: number;
}

export interface RuleOutput {
  status: DailyStatusValue;
  consecutiveBypassDays: number;
  bypassToday: boolean;
  lowVolume: boolean;
  notes: string[];
}

export function decideDailyStatus(i: RuleInput): RuleOutput {
  const notes: string[] = [];

  const bypassToday =
    i.syncOk && i.nonSplitCount >= i.bypassMinCount && i.nonSplitSales.greaterThanOrEqualTo(i.bypassMinAmount);

  let consecutive: number;
  if (!i.syncOk) {
    consecutive = i.prevConsecutive;
    notes.push('Extrato indisponível: contador de desvio mantido, sem avaliação de desvio neste dia.');
  } else if (bypassToday) {
    consecutive = i.prevConsecutive + 1;
    notes.push(`Vendas fora do split: ${i.nonSplitCount} pagamento(s), R$ ${i.nonSplitSales.toFixed(2)}.`);
  } else if (i.totalSales.isZero()) {
    consecutive = i.prevConsecutive;
    notes.push('Dia sem vendas: neutro para o contador de desvio.');
  } else {
    consecutive = 0;
    if (i.nonSplitCount > 0) {
      notes.push(`Vendas fora do split abaixo da tolerância (R$ ${i.nonSplitSales.toFixed(2)}).`);
    }
  }

  const lowVolume = i.isDueDay && i.retained.lessThan(i.dailyTarget);
  if (lowVolume) {
    notes.push(`Retido R$ ${i.retained.toFixed(2)} de uma meta de R$ ${i.dailyTarget.toFixed(2)}.`);
  }

  let status: DailyStatusValue = 'GREEN';
  if (consecutive >= Math.max(1, i.graceDays)) status = 'RED';
  else if (lowVolume || bypassToday) status = 'YELLOW';

  return { status, consecutiveBypassDays: consecutive, bypassToday, lowVolume, notes };
}
