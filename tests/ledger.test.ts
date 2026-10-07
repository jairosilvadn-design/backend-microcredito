import './setup-env';
import { Prisma } from '@prisma/client';
import { planejarBaixa, posicaoDoContrato, saldoDaParcela, type ParcelaFato, type ContratoFato } from '../src/services/credit/ledger.service';
import { quote } from '../src/services/credit/pricing.service';

let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`${c ? '✔' : '✘'} ${n}`); };
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const mora = { lateFeePercent: D(2), lateDailyPercent: D(0.033) };

const parcela = (seq: number, dueYmd: string, due = 120, paid = 0, lc = 0, status = 'PENDING'): ParcelaFato =>
  ({ id: `p${seq}`, sequence: seq, dueYmd, amountDue: D(due), amountPaid: D(paid), lateCharge: D(lc), status });

// ---- mora: a mesma conta para cobrar e para baixar ----
const emDia = saldoDaParcela(parcela(1, '2026-10-10'), '2026-10-10', mora);
check('no dia do vencimento não há mora', emDia.encargos.equals(0) && emDia.falta.equals(120));
const atrasada = saldoDaParcela(parcela(1, '2026-10-01'), '2026-10-11', mora);
// 2% de 120 = 2,40  +  0,033% x 10 dias x 120 = 0,396  => 2,80
check(`10 dias de atraso: mora de ${atrasada.encargos} e total ${atrasada.falta}`, atrasada.encargos.equals('2.8') && atrasada.falta.equals('122.8'));
const quitada = saldoDaParcela(parcela(1, '2026-10-01', 120, 122.8, 2.8, 'PAID'), '2026-12-31', mora);
check('parcela quitada tem a mora congelada (não cresce com o tempo)', quitada.falta.equals(0) && quitada.encargos.equals('2.8'));

// ---- transbordo ----
const tres = [parcela(1, '2026-10-10'), parcela(2, '2026-10-11'), parcela(3, '2026-10-12')];
const p1 = planejarBaixa({ parcelas: tres, alvoId: 'p1', valor: D(150), refYmd: '2026-10-09', mora });
check('R$150 numa parcela de R$120: quita a 1ª e R$30 vão para a 2ª', p1.alocacoes.length === 2 && p1.alocacoes[0]!.quita && p1.alocacoes[1]!.valor.equals(30) && !p1.alocacoes[1]!.quita);
check('nada sobra nem some', p1.sobra.equals(0) && p1.alocacoes.reduce((s, a) => s.plus(a.valor), D(0)).equals(150));
const p2 = planejarBaixa({ parcelas: tres, alvoId: 'p2', valor: D(120), refYmd: '2026-10-09', mora });
check('a parcela escolhida é paga primeiro, mesmo fora de ordem', p2.alocacoes.length === 1 && p2.alocacoes[0]!.parcelaId === 'p2');
const p3 = planejarBaixa({ parcelas: tres, alvoId: 'p1', valor: D(400), refYmd: '2026-10-09', mora });
check(`valor acima do saldo do contrato (R$360) é recusado: sobram R$${p3.sobra}`, p3.sobra.equals(40) && p3.saldoTotal.equals(360));
const p4 = planejarBaixa({ parcelas: [parcela(1, '2026-10-10', 120, 100, 0, 'PARTIAL')], alvoId: 'p1', valor: D(20), refYmd: '2026-10-09', mora });
check('parcela parcialmente paga: R$20 fecham os R$120', p4.alocacoes[0]!.quita);

// ---- posição: capital, juros e mora fecham com o caixa ----
const contrato = (parcelas: ParcelaFato[], status = 'ACTIVE'): ContratoFato => ({
  status, principal: D(300), netToBorrower: D(300), totalPayable: D(360), disbursedAt: new Date(), mora, parcelas,
});
const novo = posicaoDoContrato(contrato(tres), '2026-10-09');
check('contrato novo: R$300 na rua, R$360 a receber, nada de lucro ainda', novo.capitalNaRua.equals(300) && novo.aReceber.equals(360) && novo.juros.equals(0) && novo.recebido.equals(0));
const metade = posicaoDoContrato(contrato([parcela(1, '2026-10-10', 120, 120, 0, 'PAID'), parcela(2, '2026-10-11'), parcela(3, '2026-10-12')]), '2026-10-10');
check(`recebeu R$120: voltaram R$100 de capital e R$20 de juros (${metade.capitalVoltou}/${metade.juros})`, metade.capitalVoltou.equals(100) && metade.juros.equals(20) && metade.capitalNaRua.equals(200));
const comMora = posicaoDoContrato(contrato([parcela(1, '2026-10-01', 120, 122.8, 2.8, 'PAID'), parcela(2, '2026-10-02', 120, 120, 0, 'PAID'), parcela(3, '2026-10-03', 120, 120, 0, 'PAID')], 'PAID'), '2026-10-20');
check(`quitado com R$2,80 de mora: capital volta inteiro (${comMora.capitalVoltou}) e lucro = 60 + 2,80 (${comMora.juros})`, comMora.capitalVoltou.equals(300) && comMora.juros.equals('62.8') && comMora.capitalNaRua.equals(0));
check('recebido = capital que voltou + lucro (sempre fecha)', comMora.recebido.equals(comMora.capitalVoltou.plus(comMora.juros)));
const emAtraso = posicaoDoContrato(contrato([parcela(1, '2026-10-01', 120, 0, 0, 'OVERDUE'), parcela(2, '2026-10-12')]), '2026-10-11');
check('em atraso entra o valor com mora, e só o atrasado', emAtraso.emAtraso.equals('122.8') && emAtraso.aReceber.equals('242.8') && emAtraso.parcelasAtrasadas === 1);

// ---- com custos descontados, o capital é o que saiu do caixa ----
const comCustos = posicaoDoContrato({ ...contrato(tres), netToBorrower: D(295) }, '2026-10-09');
check('custos descontados: capital na rua = R$295 (o que saiu do caixa), não R$300', comCustos.capitalNaRua.equals(295));

// ---- CET não depende de "hoje" quando o cronograma é no passado ----
const q = quote({ principal: 500, ratePercent: 20, installments: 24, frequency: 'DAILY', firstDueDate: '2020-01-02', openDaysPerWeek: 6 });
check(`CET sensato (${q.cetLabel}) mesmo com datas antigas`, q.cetMonthly > 0.3 && q.cetMonthly < 0.8);

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);
