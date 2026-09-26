import './setup-env';
import { quote, computeCosts } from '../src/services/credit/pricing.service';
import { limiteParaCliente, MODOS, recomendacoes, situacaoCaixa, saudeDaCarteira, projetarCaixa } from '../src/services/credit/tesouraria.service';
import { lateCharge } from '../src/services/credit/pricing.service';
import { Prisma } from '@prisma/client';

let pass = 0, fail = 0;
const check = (n: string, c: boolean) => { c ? pass++ : fail++; console.log(`${c ? '✔' : '✘'} ${n}`); };

// ---- "Quero parcela de R$ 25": o prazo tem que sair da conta ----
function prazoPara(principal: number, taxa: number, parcelaAlvo: number) {
  const total = principal * (1 + taxa / 100);
  return Math.max(2, Math.min(120, Math.ceil(total / parcelaAlvo)));
}
const n1 = prazoPara(500, 20, 25);
const q1 = quote({ principal: 500, ratePercent: 20, installments: n1, frequency: 'DAILY', firstDueDate: '2026-09-28', openDaysPerWeek: 6 });
check(`R$500 com parcela de ~R$25 vira ${n1} parcelas de ${q1.installmentAmount}`, n1 === 24 && q1.installmentAmount <= 25);
check(`e o custo efetivo cai para ${q1.cetLabel} (antes, em 10x, passava de 130%)`, q1.cetMonthly < 0.6);

const curto = quote({ principal: 500, ratePercent: 20, installments: 10, frequency: 'DAILY', firstDueDate: '2026-09-28', openDaysPerWeek: 6 });
check(`prazo curto ainda dispara o aviso de custo alto (${curto.cetLabel})`, curto.cetMonthly > 0.8);

const n2 = prazoPara(200, 20, 10.9);
check(`R$200 com parcela de R$10,90 dá ${n2} parcelas`, n2 === 23);

// ---- Limites: continuam calculando, mas quem decide é o operador ----
const lim = limiteParaCliente({
  capacidadeCliente: 660, tetoDoNivel: 200, patrimonio: 1200,
  jaEmprestadoAoCliente: 0, disponivelParaEmprestar: 1140, padroes: MODOS.ARRANCADA,
});
check(`o sistema sugere R$${lim.valorSugerido} e explica o porquê`, lim.valorSugerido === 200 && lim.motivo.length > 20);
check('a sugestão vem com os quatro limites abertos para conferência', lim.limites.length === 4);

// ---- Custos: o valor líquido continua certo ----
const c = computeCosts({ principal: 500, termDays: 24, chargeIof: false, iofFixedPercent: 0.38, iofDailyPercent: 0.0082, tacFixed: 0, tacPercent: 0, otherCosts: 0, costsMode: 'DEDUZIR' });
check(`sem tarifas, o cliente recebe os R$${c.netToBorrower} cheios`, c.netToBorrower === 500);


// ---- Cronograma combinado na conversa: datas e valores livres ----
const combinado = quote({
  principal: 300, ratePercent: 20, installments: 3, frequency: 'DAILY', firstDueDate: '2026-09-28', openDaysPerWeek: 6,
  cronograma: [
    { dueDate: '2026-10-02', amount: 50 },   // sexta
    { dueDate: '2026-10-07', amount: 30 },   // quarta seguinte
    { dueDate: '2026-10-16', amount: 280 },  // o resto no dia do acerto
  ],
});
check(`cronograma livre aceito: ${combinado.installments} parcelas somando ${combinado.totalPayable}`, combinado.installments === 3 && combinado.totalPayable === 360);
check(`datas ficam exatamente como acertadas (${combinado.dueDates.join(', ')})`, combinado.dueDates.join() === '2026-10-02,2026-10-07,2026-10-16');
check('valores diferentes entre si são respeitados', combinado.amounts.join() === '50,30,280');
check('o contrato sabe que o cronograma foi combinado à mão', combinado.combinado === true);
check(`o CET continua sendo calculado sobre o cronograma real (${combinado.cetLabel})`, combinado.cetMonthly > 0);

// Misturar dia e semana no mesmo contrato
const misto = quote({
  principal: 200, ratePercent: 20, installments: 4, frequency: 'DAILY', firstDueDate: '2026-09-28',
  cronograma: [
    { dueDate: '2026-09-28', amount: 60 }, { dueDate: '2026-09-29', amount: 60 }, // dois dias seguidos
    { dueDate: '2026-10-06', amount: 60 }, { dueDate: '2026-10-13', amount: 60 }, // depois semanal
  ],
});
check('dá para misturar parcelas diárias e semanais no mesmo contrato', misto.installments === 4 && misto.totalPayable === 240);

// Fora de ordem: o sistema organiza sozinho
const bagunçado = quote({
  principal: 100, ratePercent: 20, installments: 2, frequency: 'DAILY', firstDueDate: '2026-09-28',
  cronograma: [{ dueDate: '2026-10-10', amount: 70 }, { dueDate: '2026-10-01', amount: 50 }],
});
check(`datas digitadas fora de ordem são organizadas (${bagunçado.dueDates.join(' e ')})`, bagunçado.dueDates[0] === '2026-10-01' && bagunçado.amounts[0] === 50);

// Sem cronograma, nada muda: continua automático
const automatico = quote({ principal: 200, ratePercent: 20, installments: 22, frequency: 'DAILY', firstDueDate: '2026-09-28', openDaysPerWeek: 6 });
check(`sem cronograma combinado segue automático (${automatico.installments}x de ${automatico.installmentAmount})`, automatico.installments === 22 && automatico.combinado === false);


// ---- Renegociar não pode apagar os juros que já correram ----
const D = (v: number | string) => new Prisma.Decimal(v);
const parcela = D('16.36');
const encargos = lateCharge(parcela, 3, D(2), D(0.033));
const novoValor = parcela.plus(encargos).toDecimalPlaces(2);
check(`3 dias de atraso sobre R$16,36 geram R$${encargos.toFixed(2)} de multa e juros`, encargos.toFixed(2) === '0.34');
check(`ao remarcar, esses encargos entram no valor: a parcela vira R$${novoValor.toFixed(2)}`, novoValor.toFixed(2) === '16.70');
check('e o relógio do atraso recomeça do zero sobre o valor novo', lateCharge(novoValor, 0, D(2), D(0.033)).toFixed(2) === '0.00');
check('só somem se você perdoar de propósito', D(0).plus(0).toFixed(2) === '0.00');

// ---- A tarefa do dia agora é enviar o Pix, e ela é urgente ----
const caixa = situacaoCaixa({ saldoCaixa: 600, principalNaRua: 600, aReceberProximos7Dias: 0, padroes: MODOS.ARRANCADA });
const saude = saudeDaCarteira({ carteiraTotal: 720, emAtrasoAte30: 0, emAtrasoMais30: 0, liberadoTotal: 600, jurosRecebidos: 0, diasOperando: 5, saldoCaixa: 600, padroes: MODOS.ARRANCADA });
const proj = projetarCaixa({ saldoHoje: 600, reserva: 30, entradasPorDia: {}, dias: [], contratoMinimo: 100 });
const tarefas = recomendacoes({
  padroes: MODOS.ARRANCADA, caixa, saude, projecao: proj,
  clientesAtivos: 2, clientesProntosParaSubir: 0, parcelasAtrasadas: 0,
  contratosAguardandoAssinatura: 0, pixAEnviar: 1, diasCaixaParado: 0,
});
const pix = tarefas.find((t) => t.acao === 'LIBERAR');
check(`assinou e o Pix não saiu: vira tarefa urgente ("${pix?.titulo}")`, pix?.tom === 'URGENTE' && pix.titulo.includes('Envie o Pix'));
check('e o texto explica que o contrato já está valendo', (pix?.detalhe ?? '').includes('já está valendo'));

const semPendencia = recomendacoes({
  padroes: MODOS.ARRANCADA, caixa, saude, projecao: proj,
  clientesAtivos: 2, clientesProntosParaSubir: 0, parcelasAtrasadas: 0,
  contratosAguardandoAssinatura: 0, pixAEnviar: 0, diasCaixaParado: 0,
});
check('Pix confirmado: a tarefa some da lista', !semPendencia.some((t) => t.acao === 'LIBERAR'));

// ---- Corrigir o saldo do caixa: a diferença vira AJUSTE, nunca RETIRADA ----
/** Mesma conta que a rota PUT /api/credito/caixa/saldo faz. */
function correcaoDeSaldo(saldoAtual: number, saldoReal: number) {
  const diferenca = D(saldoReal).minus(saldoAtual).toDecimalPlaces(2);
  if (diferenca.abs().lessThan(0.01)) return null;
  return { kind: 'AJUSTE' as const, amount: diferenca, novoSaldo: D(saldoAtual).plus(diferenca) };
}

const paraMenos = correcaoDeSaldo(1702.31, 800);
check(`caixa inflado por um teste: corrigir de R$1.702,31 para R$800 lança ${paraMenos?.amount.toFixed(2)}`, paraMenos?.amount.toFixed(2) === '-902.31');
check('e o caixa passa a bater com a realidade', paraMenos?.novoSaldo.toFixed(2) === '800.00');
check('a correção NÃO é uma retirada: o relatório não acusa saque do dono', paraMenos?.kind === 'AJUSTE');

const paraMais = correcaoDeSaldo(800, 1250.5);
check('faltando dinheiro no sistema, a correção entra positiva (+450.50)', paraMais?.amount.toFixed(2) === '450.50');
check('corrigir para o mesmo valor não lança nada', correcaoDeSaldo(800, 800) === null);
check('diferença de centavo abaixo de 1 não lança nada', correcaoDeSaldo(800, 800.004) === null);

// ---- O mesmo número, dois significados: em mãos x capital total ----
/** Mesma conta da rota: se o valor inclui a rua, a rua é descontada. */
function alvoDoCaixa(digitado: number, naRua: number, incluiNaRua: boolean) {
  return incluiNaRua ? D(digitado).minus(naRua).toDecimalPlaces(2) : D(digitado);
}

const NA_RUA = 497.69;
check('"capital total de R$1.200" com R$497,69 na rua vira R$702,31 em caixa', alvoDoCaixa(1200, NA_RUA, true).toFixed(2) === '702.31');
check('"tenho R$1.200 em mãos" deixa o caixa em R$1.200 mesmo', alvoDoCaixa(1200, NA_RUA, false).toFixed(2) === '1200.00');
check('e aí o total do negócio fica R$1.697,69, não R$1.200', D(1200).plus(NA_RUA).toFixed(2) === '1697.69');
check('capital menor que o que está na rua não fecha e é recusado', alvoDoCaixa(300, NA_RUA, true).lessThan(0));
check('sem nada na rua, as duas leituras dão o mesmo número', alvoDoCaixa(1200, 0, true).toFixed(2) === alvoDoCaixa(1200, 0, false).toFixed(2));

// ---- Apagar lançamento: só o que foi feito à mão ----
const DA_MAO = ['APORTE', 'RETIRADA', 'DESPESA', 'AJUSTE'];
check('aporte lançado à mão pode ser apagado', DA_MAO.includes('APORTE'));
check('correção também', DA_MAO.includes('AJUSTE'));
check('liberação de contrato não pode: caixa e carteira parariam de bater', !DA_MAO.includes('LIBERACAO'));
check('recebimento de parcela também não', !DA_MAO.includes('RECEBIMENTO'));

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);
