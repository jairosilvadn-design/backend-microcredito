import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { dbDateToYmd, ymdSaoPaulo, ymdToDbDate } from '../../lib/dates';
import { lateCharge } from './pricing.service';
import { buildMessage } from './contract.service';

/**
 * MOTOR FINANCEIRO DO CRÉDITO — a única fonte de verdade para "quanto falta".
 *
 * Por que existe: antes, cada tela fazia a sua própria conta (a cobrança calculava
 * a multa na hora, a baixa usava a multa gravada de ontem, os relatórios dividiam
 * o recebido de outro jeito). Resultado: o valor cobrado, o valor baixado e o
 * valor do relatório não fechavam. Agora tudo sai destas funções:
 *
 *  - FATOS (guardados):      parcelas (valor, vencimento) e pagamentos (CreditPayment)
 *  - DERIVADOS (recalculados): amountPaid, status, multa/juros, saldo do contrato
 *
 * Regras:
 *  1. Multa + juros de mora correm sobre o valor da parcela, do vencimento até o
 *     dia do pagamento (ou até hoje, se ainda aberta). Parcela quitada congela a mora.
 *  2. Todo pagamento abate PRIMEIRO a mora e depois o valor da parcela.
 *  3. Pagamento maior que a parcela transborda para as próximas, em ordem.
 *     Pagamento maior que o saldo do contrato é recusado — dinheiro nunca some.
 *  4. Cada pagamento gera exatamente um lançamento no caixa (e o estorno gera o inverso).
 */

type Tx = Prisma.TransactionClient;
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const ZERO = D(0);
const CENTAVO = D('0.01');
const r2 = (d: Prisma.Decimal) => d.toDecimalPlaces(2);
const maxD = (a: Prisma.Decimal, b: Prisma.Decimal) => (a.greaterThan(b) ? a : b);
const minD = (a: Prisma.Decimal, b: Prisma.Decimal) => (a.lessThan(b) ? a : b);

/** Erro de regra de negócio: vira resposta 4xx clara, nunca "erro inesperado". */
export class ErroDeNegocio extends Error {
  constructor(public code: string, message: string, public status = 409) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Funções puras
// ---------------------------------------------------------------------------
export interface Mora { lateFeePercent: Prisma.Decimal; lateDailyPercent: Prisma.Decimal }

export interface ParcelaFato {
  id: string;
  sequence: number;
  dueYmd: string;
  amountDue: Prisma.Decimal;
  amountPaid: Prisma.Decimal;
  lateCharge: Prisma.Decimal;
  status: string;
}

export const diasEntre = (deYmd: string, ateYmd: string) =>
  Math.round((Date.parse(`${ateYmd}T12:00:00Z`) - Date.parse(`${deYmd}T12:00:00Z`)) / 86400_000);
export const diasDeAtraso = (dueYmd: string, refYmd: string) => Math.max(0, diasEntre(dueYmd, refYmd));

/** Quanto falta pagar de uma parcela em uma data, já com multa e juros. */
export function saldoDaParcela(p: ParcelaFato, refYmd: string, mora: Mora) {
  if (p.status === 'WAIVED') return { encargos: ZERO, total: ZERO, falta: ZERO, diasAtraso: 0 };
  const diasAtraso = diasDeAtraso(p.dueYmd, refYmd);
  // Quitada: a mora ficou congelada no dia em que foi paga.
  const encargos = p.status === 'PAID' ? p.lateCharge : lateCharge(p.amountDue, diasAtraso, mora.lateFeePercent, mora.lateDailyPercent);
  const total = r2(p.amountDue.plus(encargos));
  const faltaBruta = total.minus(p.amountPaid);
  return { encargos, total, falta: faltaBruta.lessThan(CENTAVO) ? ZERO : r2(faltaBruta), diasAtraso };
}

export interface AlocacaoBaixa {
  parcelaId: string;
  sequence: number;
  valor: Prisma.Decimal;
  encargos: Prisma.Decimal;
  faltavaAntes: Prisma.Decimal;
  quita: boolean;
}

/**
 * Reparte um pagamento: primeiro na parcela escolhida, o que sobrar nas próximas
 * em aberto, pela ordem. `sobra` > 0 significa que o valor passa do saldo do contrato.
 */
export function planejarBaixa(i: {
  parcelas: ParcelaFato[]; alvoId: string; valor: Prisma.Decimal; refYmd: string; mora: Mora;
}) {
  const abertas = i.parcelas
    .filter((p) => p.status !== 'PAID' && p.status !== 'WAIVED')
    .sort((a, b) => a.sequence - b.sequence);
  const alvo = abertas.find((p) => p.id === i.alvoId);
  const ordem = alvo ? [alvo, ...abertas.filter((p) => p.id !== i.alvoId)] : abertas;

  let restante = r2(i.valor);
  const alocacoes: AlocacaoBaixa[] = [];
  let saldoTotal = ZERO;
  for (const p of ordem) {
    const s = saldoDaParcela(p, i.refYmd, i.mora);
    saldoTotal = saldoTotal.plus(s.falta);
    if (restante.lessThanOrEqualTo(0) || s.falta.lessThanOrEqualTo(0)) continue;
    const parte = minD(restante, s.falta);
    alocacoes.push({
      parcelaId: p.id, sequence: p.sequence, valor: parte, encargos: s.encargos,
      faltavaAntes: s.falta, quita: parte.plus(CENTAVO).greaterThanOrEqualTo(s.falta),
    });
    restante = r2(restante.minus(parte));
  }
  return { alocacoes, sobra: restante.lessThan(CENTAVO) ? ZERO : restante, saldoTotal: r2(saldoTotal) };
}

export interface ContratoFato {
  status: string;
  principal: Prisma.Decimal;
  netToBorrower: Prisma.Decimal;
  totalPayable: Prisma.Decimal;
  disbursedAt: Date | null;
  mora: Mora;
  parcelas: ParcelaFato[];
}

/** Capital que realmente saiu do caixa (valor líquido, se houve custos descontados). */
export const capitalDoContrato = (c: Pick<ContratoFato, 'principal' | 'netToBorrower'>) =>
  c.netToBorrower.greaterThan(0) ? c.netToBorrower : c.principal;

/**
 * Onde está o dinheiro de um contrato. Mesma conta para o painel, o gestor e o resumo.
 *  - capital:      o que saiu do caixa para o cliente
 *  - recebido:     tudo que o cliente já pagou
 *  - capitalVoltou / juros: o recebido repartido (mora é lucro; o resto, na proporção do contrato)
 *  - aReceber:     o que falta, com multa e juros até hoje
 */
export function posicaoDoContrato(c: ContratoFato, refYmd: string) {
  const capital = capitalDoContrato(c);
  const contratual = c.parcelas.reduce((s, p) => (p.status === 'WAIVED' ? s : s.plus(p.amountDue)), ZERO);
  const fatia = contratual.greaterThan(0) ? minD(D(1), capital.div(contratual)) : D(1);

  let recebido = ZERO, capitalVoltou = ZERO, juros = ZERO, aReceber = ZERO, emAtraso = ZERO, maxDiasAtraso = 0;
  let parcelasAtrasadas = 0;
  for (const p of c.parcelas) {
    if (p.status === 'WAIVED') continue;
    const mora = minD(p.amountPaid, p.lateCharge);
    const contratualPago = p.amountPaid.minus(mora);
    recebido = recebido.plus(p.amountPaid);
    capitalVoltou = capitalVoltou.plus(contratualPago.mul(fatia));
    juros = juros.plus(contratualPago.mul(D(1).minus(fatia))).plus(mora);

    const s = saldoDaParcela(p, refYmd, c.mora);
    aReceber = aReceber.plus(s.falta);
    if (s.falta.greaterThan(0) && s.diasAtraso > 0) {
      emAtraso = emAtraso.plus(s.falta);
      parcelasAtrasadas++;
      maxDiasAtraso = Math.max(maxDiasAtraso, s.diasAtraso);
    }
  }
  capitalVoltou = minD(capitalVoltou, capital);
  const aberto = c.status === 'ACTIVE' || c.status === 'DEFAULTED';
  const jurosContratuais = maxD(ZERO, contratual.minus(capital));
  return {
    capital: r2(capital), contratual: r2(contratual), recebido: r2(recebido),
    capitalVoltou: r2(capitalVoltou), juros: r2(juros),
    capitalNaRua: aberto ? r2(maxD(ZERO, capital.minus(capitalVoltou))) : ZERO,
    aReceber: aberto ? r2(aReceber) : ZERO,
    emAtraso: aberto ? r2(emAtraso) : ZERO,
    jurosPrevistos: aberto ? r2(maxD(ZERO, jurosContratuais.minus(minD(juros, jurosContratuais)))) : ZERO,
    parcelasAtrasadas: aberto ? parcelasAtrasadas : 0,
    maxDiasAtraso,
  };
}

export function paraParcelaFato(i: {
  id: string; sequence: number; dueDate: Date; amountDue: Prisma.Decimal; amountPaid: Prisma.Decimal;
  lateCharge: Prisma.Decimal; status: string;
}): ParcelaFato {
  return {
    id: i.id, sequence: i.sequence, dueYmd: dbDateToYmd(i.dueDate), amountDue: i.amountDue,
    amountPaid: i.amountPaid, lateCharge: i.lateCharge, status: i.status,
  };
}

// ---------------------------------------------------------------------------
// Banco de dados
// ---------------------------------------------------------------------------
/** Trava a linha do contrato até o fim da transação: duas baixas simultâneas não se atropelam. */
export async function travarContrato(tx: Tx, contractId: string) {
  await tx.$queryRaw`SELECT id FROM "CreditContract" WHERE id = ${contractId}::uuid FOR UPDATE`;
}

export const TX_OPTS = { timeout: 30_000, maxWait: 10_000 } as const;

/**
 * Recalcula tudo que é derivado de um contrato a partir dos fatos (parcelas e
 * pagamentos): valor pago, situação, multa, saldo, status do contrato e do cliente.
 * É idempotente — rodar duas vezes dá o mesmo resultado — e é também o reparo
 * usado pela conferência.
 */
export async function recalcularContrato(tx: Tx, contractId: string, refYmd = ymdSaoPaulo(), aplicar = true) {
  const c = await tx.creditContract.findUniqueOrThrow({
    where: { id: contractId },
    include: { installments: { orderBy: { sequence: 'asc' }, include: { payments: true } } },
  });
  const mora: Mora = { lateFeePercent: c.lateFeePercent, lateDailyPercent: c.lateDailyPercent };
  const mudancas: string[] = [];

  let outstanding = ZERO, maxAtraso = 0, quitado = c.installments.length > 0;
  for (const i of c.installments) {
    if (i.status === 'WAIVED') continue;
    const pago = i.payments.reduce((s, p) => s.plus(p.amount), ZERO);
    const ultimo = i.payments.reduce<Date | null>((mx, p) => (!mx || p.paidAt > mx ? p.paidAt : mx), null);
    const due = dbDateToYmd(i.dueDate);

    let status: 'PENDING' | 'PARTIAL' | 'PAID' | 'OVERDUE';
    let encargos: Prisma.Decimal;
    let paidAt: Date | null = null;
    const encNoUltimo = ultimo ? lateCharge(i.amountDue, diasDeAtraso(due, ymdSaoPaulo(ultimo)), mora.lateFeePercent, mora.lateDailyPercent) : ZERO;
    if (ultimo && pago.plus(CENTAVO).greaterThanOrEqualTo(i.amountDue.plus(encNoUltimo))) {
      status = 'PAID'; encargos = encNoUltimo; paidAt = ultimo;
    } else {
      const dias = diasDeAtraso(due, refYmd);
      encargos = lateCharge(i.amountDue, dias, mora.lateFeePercent, mora.lateDailyPercent);
      status = dias > 0 ? 'OVERDUE' : pago.greaterThan(0) ? 'PARTIAL' : 'PENDING';
      maxAtraso = Math.max(maxAtraso, dias);
      quitado = false;
      outstanding = outstanding.plus(maxD(ZERO, r2(i.amountDue.plus(encargos).minus(pago))));
    }

    if (!pago.equals(i.amountPaid) || status !== i.status || !encargos.equals(i.lateCharge) || (paidAt?.getTime() ?? 0) !== (i.paidAt?.getTime() ?? 0)) {
      if (!pago.equals(i.amountPaid)) mudancas.push(`Parcela ${i.sequence}: valor pago estava ${i.amountPaid.toFixed(2)} e os pagamentos somam ${pago.toFixed(2)}`);
      if (aplicar) await tx.creditInstallment.update({ where: { id: i.id }, data: { amountPaid: pago, status, lateCharge: encargos, paidAt } });
    }
  }
  outstanding = r2(outstanding);

  let novoStatus = c.status as string;
  if (['ACTIVE', 'DEFAULTED', 'PAID'].includes(c.status)) {
    if (quitado) novoStatus = 'PAID';
    else if (c.status === 'PAID') novoStatus = 'ACTIVE';
    else if (c.status === 'DEFAULTED' && maxAtraso < 30) novoStatus = 'ACTIVE';
    else if (c.status === 'ACTIVE' && maxAtraso >= 30) novoStatus = 'DEFAULTED';
  }
  // Com parcela vencida a mora cresce todo dia; o ajuste diário (7h) cuida disso. Só é divergência de verdade sem atraso.
  if (!c.outstanding.equals(outstanding) && maxAtraso === 0 && ['ACTIVE', 'DEFAULTED', 'PAID'].includes(c.status)) {
    mudancas.push(`Saldo do contrato estava ${c.outstanding.toFixed(2)} e o correto é ${outstanding.toFixed(2)}`);
  }
  if (aplicar && ['ACTIVE', 'DEFAULTED', 'PAID'].includes(c.status) && (novoStatus !== c.status || !c.outstanding.equals(outstanding))) {
    await tx.creditContract.update({
      where: { id: contractId },
      data: {
        outstanding, status: novoStatus as never,
        paidAt: novoStatus === 'PAID' ? (c.paidAt ?? new Date()) : null,
        defaultedAt: novoStatus === 'DEFAULTED' ? (c.defaultedAt ?? new Date()) : null,
      },
    });
  }

  // Semáforo do cliente sempre acompanha o contrato, sem esperar o relógio das 7h.
  if (aplicar && (novoStatus === 'ACTIVE' || novoStatus === 'DEFAULTED')) {
    const semaforo = maxAtraso >= 15 ? 'INADIMPLENTE' : maxAtraso > 0 ? 'ATRASADO' : 'ATIVO';
    await tx.borrower.update({ where: { id: c.borrowerId }, data: { status: semaforo } });
  }

  return {
    outstanding, status: novoStatus, maxAtraso, mudancas,
    quitouAgora: novoStatus === 'PAID' && c.status !== 'PAID',
    reabriu: novoStatus !== 'PAID' && c.status === 'PAID',
    statusAnterior: c.status, borrowerId: c.borrowerId,
  };
}

export interface BaixaInput {
  parcelaId: string;
  valor?: number;
  paidAtYmd?: string;
  method: 'PIX' | 'DINHEIRO' | 'TRANSFERENCIA' | 'OUTRO';
  receiptRef?: string;
  note?: string;
  operatorId: string;
}

/** Registra um pagamento (com transbordo para as próximas parcelas, se for o caso). */
export async function registrarBaixa(prisma: PrismaClient, i: BaixaInput) {
  const hoje = ymdSaoPaulo();
  const dia = i.paidAtYmd ?? hoje;
  if (dia > hoje) throw new ErroDeNegocio('data_futura', 'A data do pagamento não pode ser no futuro.', 422);
  const paidAt = i.paidAtYmd ? new Date(`${i.paidAtYmd}T12:00:00.000-03:00`) : new Date();

  return prisma.$transaction(async (tx) => {
    const base = await tx.creditInstallment.findUnique({ where: { id: i.parcelaId }, select: { contractId: true } });
    if (!base) throw new ErroDeNegocio('not_found', 'Parcela não encontrada', 404);
    await travarContrato(tx, base.contractId);

    // Lê DEPOIS da trava: se outra baixa acabou de passar, enxergamos o resultado dela.
    const contract = await tx.creditContract.findUniqueOrThrow({
      where: { id: base.contractId },
      include: { borrower: true, installments: { orderBy: { sequence: 'asc' } } },
    });
    if (!['ACTIVE', 'DEFAULTED'].includes(contract.status)) throw new ErroDeNegocio('contract_not_active', 'O contrato não está ativo.');

    const parcelas = contract.installments.map(paraParcelaFato);
    const alvo = parcelas.find((p) => p.id === i.parcelaId)!;
    if (alvo.status === 'PAID') throw new ErroDeNegocio('already_paid', 'Esta parcela já está baixada.');

    const mora: Mora = { lateFeePercent: contract.lateFeePercent, lateDailyPercent: contract.lateDailyPercent };
    // Sem valor informado: quita a parcela inteira, com a mora do dia — o mesmo número que a tela de cobranças mostra.
    const valor = i.valor != null ? D(i.valor) : saldoDaParcela(alvo, dia, mora).falta;
    if (valor.lessThanOrEqualTo(0)) throw new ErroDeNegocio('nada_a_baixar', 'Não há valor em aberto nesta parcela.', 422);

    const plano = planejarBaixa({ parcelas, alvoId: i.parcelaId, valor, refYmd: dia, mora });
    if (plano.sobra.greaterThan(0)) {
      throw new ErroDeNegocio(
        'excede_saldo',
        `O valor passa do que falta no contrato (R$ ${plano.saldoTotal.toFixed(2)} até ${dia.split('-').reverse().join('/')}). Confira o valor: sobrariam R$ ${plano.sobra.toFixed(2)}.`,
        422,
      );
    }

    // Trava contra clique duplo: mesma baixa, mesmo contrato, nos últimos segundos.
    const recente = await tx.creditPayment.findFirst({
      where: {
        installment: { contractId: contract.id }, operatorId: i.operatorId, method: i.method,
        amount: plano.alocacoes[0]!.valor, paidAt, createdAt: { gte: new Date(Date.now() - 15_000) },
      },
    });
    if (recente) throw new ErroDeNegocio('baixa_duplicada', 'Uma baixa idêntica acabou de ser registrada. Se foi um clique duplo, nada mais a fazer.');

    for (const a of plano.alocacoes) {
      await tx.creditPayment.create({
        data: { installmentId: a.parcelaId, amount: a.valor, paidAt, method: i.method, receiptRef: i.receiptRef ?? null, note: i.note ?? null, operatorId: i.operatorId },
      });
      await tx.cashEntry.create({
        data: {
          kind: 'RECEBIMENTO', amount: a.valor, happenedAt: paidAt,
          description: `Parcela ${a.sequence} do contrato ${contract.number} — ${contract.borrower.name}`,
          contractId: contract.id, borrowerId: contract.borrowerId, operatorId: i.operatorId,
        },
      });
    }

    const r = await recalcularContrato(tx, contract.id);

    const quitadas = plano.alocacoes.filter((a) => a.quita).map((a) => a.parcelaId);
    if (quitadas.length) {
      await tx.creditNotification.updateMany({ where: { installmentId: { in: quitadas }, status: 'PENDENTE' }, data: { status: 'DISPENSADA' } });
    }

    let levelUp: string | null = null;
    if (r.quitouAgora) {
      // Quitou: sobe um nível se o contrato não teve mais de 2 parcelas pagas com atraso.
      const depois = await tx.creditInstallment.findMany({ where: { contractId: contract.id }, select: { lateCharge: true } });
      const atrasadas = depois.filter((p) => p.lateCharge.greaterThan(0)).length;
      const borrower = await tx.borrower.findUniqueOrThrow({ where: { id: contract.borrowerId }, include: { level: true } });
      const next = atrasadas <= 2 ? await tx.creditLevel.findFirst({ where: { rank: (borrower.level?.rank ?? 1) + 1, active: true } }) : null;
      await tx.borrower.update({
        where: { id: borrower.id },
        data: { status: 'EM_DIA', cyclesPaid: { increment: 1 }, ...(next ? { levelId: next.id } : {}) },
      });
      if (next) levelUp = next.name;
      await tx.creditNotification.create({
        data: {
          borrowerId: borrower.id, contractId: contract.id, kind: 'QUITACAO', referenceDate: ymdToDbDate(hoje),
          message: buildMessage('QUITACAO', { firstName: borrower.name.split(' ')[0] ?? borrower.name, contractNumber: contract.number }),
        },
      });
    }

    return {
      settled: plano.alocacoes[0]?.parcelaId === i.parcelaId && plano.alocacoes[0].quita,
      finished: r.quitouAgora, levelUp,
      outstanding: r.outstanding.toFixed(2),
      recebido: r2(valor).toFixed(2),
      contractId: contract.id,
      alocacoes: plano.alocacoes.map((a) => ({
        sequence: a.sequence, valor: a.valor.toFixed(2), quitou: a.quita, encargos: a.encargos.toFixed(2),
      })),
    };
  }, TX_OPTS);
}

/** Desfaz um pagamento lançado por engano: apaga a baixa, estorna o caixa e recalcula. */
export async function estornarPagamento(prisma: PrismaClient, i: { paymentId: string; motivo: string; operatorId: string }) {
  return prisma.$transaction(async (tx) => {
    const base = await tx.creditPayment.findUnique({ where: { id: i.paymentId }, include: { installment: { select: { contractId: true, sequence: true } } } });
    if (!base) throw new ErroDeNegocio('not_found', 'Pagamento não encontrado', 404);
    await travarContrato(tx, base.installment.contractId);

    const pay = await tx.creditPayment.findUnique({ where: { id: i.paymentId } });
    if (!pay) throw new ErroDeNegocio('ja_estornado', 'Este pagamento já foi estornado.');
    const contract = await tx.creditContract.findUniqueOrThrow({ where: { id: base.installment.contractId }, include: { borrower: true } });
    if (contract.status === 'CANCELLED') throw new ErroDeNegocio('contract_cancelled', 'O contrato está cancelado.');

    await tx.creditPayment.delete({ where: { id: pay.id } });
    await tx.cashEntry.create({
      data: {
        kind: 'AJUSTE', amount: pay.amount.negated(), happenedAt: new Date(),
        description: `Estorno de pagamento da parcela ${base.installment.sequence} do contrato ${contract.number} — ${i.motivo}`,
        contractId: contract.id, borrowerId: contract.borrowerId, operatorId: i.operatorId,
      },
    });
    const r = await recalcularContrato(tx, contract.id);
    if (r.reabriu) {
      await tx.borrower.update({
        where: { id: contract.borrowerId },
        data: { cyclesPaid: contract.borrower.cyclesPaid > 0 ? { decrement: 1 } : undefined },
      });
    }
    return {
      ok: true, valorEstornado: pay.amount.toFixed(2), contratoReaberto: r.reabriu,
      outstanding: r.outstanding.toFixed(2),
      aviso: r.reabriu && contract.borrower.levelId ? 'O contrato voltou a ficar em aberto. Se o cliente tinha subido de nível ao quitar, confira o nível dele.' : null,
    };
  }, TX_OPTS);
}

export interface Divergencia { contrato: string; tipo: 'PARCELA_OU_SALDO' | 'CAIXA'; detalhe: string; corrigido: boolean }

/**
 * Conferência: compara o que está gravado com o que os fatos dizem.
 * Com `corrigir`, refaz os derivados e lança um ajuste de caixa (com o contrato
 * no histórico) para cada diferença — nunca apaga lançamento.
 */
export async function conferirCarteira(prisma: PrismaClient, i: { corrigir: boolean; operatorId: string }) {
  const contratos = await prisma.creditContract.findMany({
    where: { status: { in: ['ACTIVE', 'DEFAULTED', 'PAID', 'CANCELLED'] } },
    select: { id: true, number: true, status: true, principal: true, netToBorrower: true },
  });
  const divergencias: Divergencia[] = [];

  for (const c of contratos) {
    await prisma.$transaction(async (tx) => {
      if (i.corrigir) await travarContrato(tx, c.id);
      const pagos = await tx.creditPayment.aggregate({ _sum: { amount: true }, where: { installment: { contractId: c.id } } });
      const pago = pagos._sum.amount ?? ZERO;

      if (c.status !== 'CANCELLED') {
        const r = await recalcularContrato(tx, c.id, ymdSaoPaulo(), i.corrigir);
        for (const m of r.mudancas) divergencias.push({ contrato: c.number, tipo: 'PARCELA_OU_SALDO', detalhe: m, corrigido: i.corrigir });
      }

      // Caixa esperado do contrato: saiu o líquido, entrou tudo que foi pago.
      const esperado = c.status === 'CANCELLED' ? ZERO : pago.minus(capitalDoContrato(c));
      const real = (await tx.cashEntry.aggregate({ _sum: { amount: true }, where: { contractId: c.id } }))._sum.amount ?? ZERO;
      const diff = r2(esperado.minus(real));
      if (diff.abs().greaterThanOrEqualTo(CENTAVO)) {
        divergencias.push({
          contrato: c.number, tipo: 'CAIXA', corrigido: i.corrigir,
          detalhe: `O caixa tem ${real.toFixed(2)} lançado neste contrato, mas o correto é ${esperado.toFixed(2)} (diferença de ${diff.toFixed(2)}).`,
        });
        if (i.corrigir) {
          await tx.cashEntry.create({
            data: {
              kind: 'AJUSTE', amount: diff, happenedAt: new Date(), contractId: c.id, operatorId: i.operatorId,
              description: `Conferência: acerto do contrato ${c.number} (${diff.greaterThan(0) ? 'faltava lançar' : 'lançado a mais'} ${diff.abs().toFixed(2)})`,
            },
          });
        }
      }
    }, TX_OPTS);
  }
  return { contratosConferidos: contratos.length, divergencias, tudoCerto: divergencias.length === 0 };
}
