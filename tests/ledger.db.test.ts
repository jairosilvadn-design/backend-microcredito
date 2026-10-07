/**
 * Teste de integração com Postgres REAL (não mocka nada).
 * Uso: DATABASE_URL=postgresql://... DIRECT_URL=... npm run test:db   (banco descartável!)
 */
import { Prisma } from '@prisma/client';
import { prisma } from '../src/lib/prisma';
import { addDaysYmd, ymdSaoPaulo, ymdToDbDate } from '../src/lib/dates';
import { conferirCarteira, estornarPagamento, posicaoDoContrato, paraParcelaFato, recalcularContrato, registrarBaixa, ErroDeNegocio, TX_OPTS } from '../src/services/credit/ledger.service';

if (!/localhost|127\.0\.0\.1|\/tmp/.test(process.env.DATABASE_URL ?? '')) {
  console.error('Recusado: este teste apaga dados. Use um banco local descartável.'); process.exit(2);
}

let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`${c ? '✔' : '✘'} ${n}`); };
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const hoje = ymdSaoPaulo();
let seq = 0;

async function criarContrato(dias: number[], opts: { principal?: number; parcela?: number } = {}) {
  const n = ++seq;
  const principal = opts.principal ?? 300, parcela = opts.parcela ?? 120;
  const b = await prisma.borrower.create({
    data: { personType: 'PJ', document: `9${String(n).padStart(13, '0')}`, name: `Cliente ${n}`, whatsapp: '+5517999999999', addressCity: 'Rio Preto', addressState: 'SP', segment: 'mercearia', status: 'ATIVO' },
  });
  const c = await prisma.creditContract.create({
    data: {
      number: `T-${Date.now()}-${n}`, borrowerId: b.id, principal: D(principal), ratePercent: D(20), totalPayable: D(parcela * dias.length),
      frequency: 'DAILY', installmentsCount: dias.length, installmentAmount: D(parcela), firstDueDate: ymdToDbDate(addDaysYmd(hoje, dias[0]!)),
      cetMonthly: D(0.4), netToBorrower: D(principal), status: 'ACTIVE', outstanding: D(parcela * dias.length),
      contractText: 't', contractHash: 'h', payToPixKey: 'pix', disbursedAt: new Date(), disbursedProof: 'ok',
      installments: { createMany: { data: dias.map((d, i) => ({ sequence: i + 1, dueDate: ymdToDbDate(addDaysYmd(hoje, d)), amountDue: D(parcela) })) } },
    },
    include: { installments: { orderBy: { sequence: 'asc' } } },
  });
  await prisma.cashEntry.create({ data: { kind: 'LIBERACAO', amount: D(-principal), happenedAt: new Date(), description: 'lib', contractId: c.id, borrowerId: b.id } });
  return { b, c, parcelas: c.installments };
}
const op = async () => (await prisma.operator.upsert({ where: { email: 't@t.com' }, create: { email: 't@t.com', name: 'T', role: 'admin' }, update: {} })).id;
const caixaDe = async (id: string) => Number((await prisma.cashEntry.aggregate({ _sum: { amount: true }, where: { contractId: id } }))._sum.amount ?? 0);
const contrato = (id: string) => prisma.creditContract.findUniqueOrThrow({ where: { id }, include: { installments: { orderBy: { sequence: 'asc' } } } });

async function main() {
  // Começa sempre do zero (o guarda acima garante que é um banco local descartável).
  await prisma.$executeRawUnsafe('TRUNCATE "CashEntry", "CreditPayment", "CreditNotification", "CreditInstallment", "ContractSignature", "BorrowerDocument", "CreditContract", "StatementAnalysis", "Borrower", "AppSetting", "AuditLog" RESTART IDENTITY CASCADE');
  const operatorId = await op();
  const base = { method: 'PIX' as const, operatorId };

  // 1) baixa normal
  const A = await criarContrato([1, 2, 3]);
  let r = await registrarBaixa(prisma, { ...base, parcelaId: A.parcelas[0]!.id });
  let c = await contrato(A.c.id);
  check('baixa sem valor quita a parcela inteira (R$120)', r.settled && c.installments[0]!.status === 'PAID' && c.installments[0]!.amountPaid.equals(120));
  check('saldo do contrato cai para R$240', c.outstanding.equals(240));
  check('caixa do contrato: -300 + 120 = -180', (await caixaDe(A.c.id)) === -180);

  // 2) clique duplo
  let erro = '';
  try { await registrarBaixa(prisma, { ...base, parcelaId: A.parcelas[0]!.id }); } catch (e) { erro = (e as ErroDeNegocio).code; }
  check(`segunda baixa da mesma parcela é recusada (${erro})`, erro === 'already_paid');

  // 3) pagamento maior que a parcela transborda
  r = await registrarBaixa(prisma, { ...base, parcelaId: A.parcelas[1]!.id, valor: 150 });
  c = await contrato(A.c.id);
  check('R$150 na parcela 2: quita a 2 e R$30 entram na 3 (nada se perde)', c.installments[1]!.status === 'PAID' && c.installments[2]!.amountPaid.equals(30) && c.installments[2]!.status === 'PARTIAL');
  check('saldo do contrato R$90 e caixa -300+270 = -30', c.outstanding.equals(90) && (await caixaDe(A.c.id)) === -30);

  // 4) valor acima do saldo
  erro = '';
  try { await registrarBaixa(prisma, { ...base, parcelaId: A.parcelas[2]!.id, valor: 500 }); } catch (e) { erro = (e as ErroDeNegocio).code; }
  const semMudanca = await caixaDe(A.c.id);
  check('R$500 num contrato que deve R$90 é recusado e o caixa não mexe', erro === 'excede_saldo' && semMudanca === -30);

  // 5) quitar: contrato vira PAID, cliente EM_DIA
  r = await registrarBaixa(prisma, { ...base, parcelaId: A.parcelas[2]!.id });
  c = await contrato(A.c.id);
  const bA = await prisma.borrower.findUniqueOrThrow({ where: { id: A.b.id } });
  check('quitou: contrato PAID, saldo zero, cliente EM_DIA', r.finished && c.status === 'PAID' && c.outstanding.equals(0) && bA.status === 'EM_DIA');
  check('caixa do contrato fecha em +60 (o lucro)', (await caixaDe(A.c.id)) === 60);

  // 6) estorno reabre
  const pay = await prisma.creditPayment.findFirstOrThrow({ where: { installmentId: A.parcelas[2]!.id }, orderBy: { createdAt: 'desc' } });
  const est = await estornarPagamento(prisma, { paymentId: pay.id, motivo: 'lancei errado', operatorId });
  c = await contrato(A.c.id);
  check('estorno reabre o contrato e devolve o saldo (R$90)', est.contratoReaberto && c.status === 'ACTIVE' && c.outstanding.equals(90));
  check('estorno desfaz o caixa (volta a -30)', (await caixaDe(A.c.id)) === -30);

  // 7) atraso: o que a cobrança mostra é o que a baixa quita
  const B = await criarContrato([-10, 5, 6]);
  await prisma.$transaction((tx) => recalcularContrato(tx, B.c.id), TX_OPTS);
  const Bc = await contrato(B.c.id);
  const mora = Bc.installments[0]!.lateCharge;
  check(`parcela com 10 dias de atraso ganha mora de R$${mora} (2% + 10 x 0,033%)`, mora.equals('2.8') && Bc.installments[0]!.status === 'OVERDUE');
  check('saldo do contrato já inclui a mora (R$362,80)', Bc.outstanding.equals('362.8'));
  r = await registrarBaixa(prisma, { ...base, parcelaId: B.parcelas[0]!.id });
  check(`baixa sem valor cobra R$122,80 (parcela + mora): recebido ${r.recebido}`, r.recebido === '122.80');
  const Bd = await contrato(B.c.id);
  check('parcela atrasada fica PAID, com a mora registrada', Bd.installments[0]!.status === 'PAID' && Bd.installments[0]!.lateCharge.equals('2.8'));

  // 8) concorrência: dois cliques ao mesmo tempo
  const C = await criarContrato([1, 2]);
  const resultados = await Promise.allSettled([
    registrarBaixa(prisma, { ...base, parcelaId: C.parcelas[0]!.id }),
    registrarBaixa(prisma, { ...base, parcelaId: C.parcelas[0]!.id }),
    registrarBaixa(prisma, { ...base, parcelaId: C.parcelas[0]!.id }),
  ]);
  const ok = resultados.filter((x) => x.status === 'fulfilled').length;
  check(`3 baixas simultâneas da mesma parcela: só 1 vale (${ok})`, ok === 1);
  check('o caixa recebeu uma vez só (-300 + 120)', (await caixaDe(C.c.id)) === -180);

  // 9) posição bate com o caixa
  const Cc = await prisma.creditContract.findUniqueOrThrow({ where: { id: C.c.id }, include: { installments: true } });
  const pos = posicaoDoContrato({ status: Cc.status, principal: Cc.principal, netToBorrower: Cc.netToBorrower, totalPayable: Cc.totalPayable, disbursedAt: Cc.disbursedAt, mora: Cc, parcelas: Cc.installments.map(paraParcelaFato) }, hoje);
  check(`posição: recebido ${pos.recebido} = capital que voltou ${pos.capitalVoltou} + lucro ${pos.juros}`, pos.recebido.equals(pos.capitalVoltou.plus(pos.juros)));

  // 10) conferência acha e corrige dado quebrado
  await prisma.creditInstallment.update({ where: { id: C.parcelas[0]!.id }, data: { amountPaid: D(999), status: 'PENDING' } });
  await prisma.cashEntry.deleteMany({ where: { contractId: C.c.id, kind: 'RECEBIMENTO' } });
  const so = await conferirCarteira(prisma, { corrigir: false, operatorId });
  const mine = so.divergencias.filter((d) => d.contrato === C.c.number);
  check(`conferência (só leitura) aponta ${mine.length} problema(s) do contrato quebrado`, mine.some((d) => d.tipo === 'PARCELA_OU_SALDO') && mine.some((d) => d.tipo === 'CAIXA'));
  check('só leitura não alterou nada', (await prisma.creditInstallment.findUniqueOrThrow({ where: { id: C.parcelas[0]!.id } })).amountPaid.equals(999));
  await conferirCarteira(prisma, { corrigir: true, operatorId });
  const dep = await conferirCarteira(prisma, { corrigir: false, operatorId });
  check('depois de corrigir, a conferência não acha mais nada neste contrato', dep.divergencias.filter((d) => d.contrato === C.c.number).length === 0);
  check('parcela voltou a refletir os pagamentos reais (R$120)', (await prisma.creditInstallment.findUniqueOrThrow({ where: { id: C.parcelas[0]!.id } })).amountPaid.equals(120));

  console.log(`\n${pass} passaram, ${fail} falharam`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
