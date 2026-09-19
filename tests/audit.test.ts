import './setup-env';
import Fastify from 'fastify';
import { Prisma } from '@prisma/client';
import { decideDailyStatus } from '../src/services/audit/rules';
import { fetchPaymentsUpdatedBetween } from '../src/services/audit/statement-sync.service';
import { dayBoundsSaoPaulo, ymdRange, addDaysYmd } from '../src/lib/dates';
import { isSale } from '../src/services/audit/payment-classifier';

const D = (v: number) => new Prisma.Decimal(v);
let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => { cond ? pass++ : fail++; console.log(`${cond ? '✔' : '✘'} ${name}`); };

// ---------------- 1. Motor de regras: simulação de uma semana ----------------
const base = { isDueDay: true, dailyTarget: D(50), graceDays: 2, syncOk: true, bypassMinAmount: D(10), bypassMinCount: 1 };
type Day = { retained: number; total: number; nonSplit: number; count: number; due?: boolean; sync?: boolean };
const semana: [string, Day, string, number][] = [
  ['seg: meta batida, tudo no split',          { retained: 55, total: 550, nonSplit: 0, count: 0 },  'GREEN', 0],
  ['ter: faturou pouco',                        { retained: 20, total: 200, nonSplit: 0, count: 0 },  'YELLOW', 0],
  ['qua: vendeu na maquininha (1º dia)',        { retained: 60, total: 900, nonSplit: 300, count: 4 }, 'YELLOW', 1],
  ['qui: loja fechada (neutro)',                { retained: 0, total: 0, nonSplit: 0, count: 0 },      'YELLOW', 1],
  ['sex: maquininha de novo (2º dia) -> RED',   { retained: 10, total: 700, nonSplit: 600, count: 9 }, 'RED', 2],
  ['sáb: extrato indisponível (mantém)',        { retained: 0, total: 0, nonSplit: 0, count: 0, sync: false }, 'RED', 2],
  ['dom: voltou ao split, sem parcela',         { retained: 30, total: 300, nonSplit: 0, count: 0, due: false }, 'GREEN', 0],
];
let prev = 0;
for (const [nome, d, esperado, cont] of semana) {
  const r = decideDailyStatus({ ...base, isDueDay: d.due ?? true, syncOk: d.sync ?? true, retained: D(d.retained),
    totalSales: D(d.total), nonSplitSales: D(d.nonSplit), nonSplitCount: d.count, prevConsecutive: prev });
  check(`${nome} => ${r.status} (contador ${r.consecutiveBypassDays})`, r.status === esperado && r.consecutiveBypassDays === cont);
  prev = r.consecutiveBypassDays;
}
const tol = decideDailyStatus({ ...base, retained: D(60), totalSales: D(500), nonSplitSales: D(5), nonSplitCount: 1, prevConsecutive: 1 });
check('desvio abaixo da tolerância (R$5) zera o contador e fica GREEN', tol.status === 'GREEN' && tol.consecutiveBypassDays === 0);
const g3 = decideDailyStatus({ ...base, graceDays: 3, retained: D(60), totalSales: D(500), nonSplitSales: D(100), nonSplitCount: 2, prevConsecutive: 1 });
check('contrato com carência de 3 dias: 2º dia de desvio ainda é YELLOW', g3.status === 'YELLOW' && g3.consecutiveBypassDays === 2);

// ---------------- 2. Datas ----------------
const b = dayBoundsSaoPaulo('2026-09-18');
check(`limites do dia SP: ${b.start.toISOString()} -> ${b.end.toISOString()}`, b.start.toISOString() === '2026-09-18T03:00:00.000Z' && b.end.toISOString() === '2026-09-19T03:00:00.000Z');
check('virada de mês/ano', addDaysYmd('2026-12-31', 1) === '2027-01-01' && ymdRange('2026-02-27', '2026-03-01').length === 3);

// ---------------- 3. Classificação ----------------
const p = (o: object) => ({ id: 1, status: 'approved', operation_type: 'regular_payment', transaction_amount: 10, date_created: '', collector_id: 42, ...o });
check('venda aprovada conta', isSale(p({}) as any, 42n));
check('transferência não conta', !isSale(p({ operation_type: 'money_transfer' }) as any, 42n));
check('estornada não conta', !isSale(p({ status: 'refunded' }) as any, 42n));
check('pagamento FEITO pelo comerciante não conta', !isSale(p({ collector_id: 99 }) as any, 42n));

// ---------------- 4. Paginação e divisão de janela do /v1/payments/search ----------------
(async () => {
  const all = Array.from({ length: 2300 }, (_, i) => ({ id: i + 1, t: Date.parse('2026-09-18T03:00:00Z') + i * 30_000 }));
  let calls = 0;
  (globalThis as any).fetch = async (url: string) => {
    calls++;
    const u = new URL(url);
    const beg = Date.parse(u.searchParams.get('begin_date')!), end = Date.parse(u.searchParams.get('end_date')!);
    const off = Number(u.searchParams.get('offset')), lim = Number(u.searchParams.get('limit'));
    const inWin = all.filter((x) => x.t >= beg && x.t <= end);
    const results = inWin.slice(off, off + lim).map((x) => ({ id: x.id, status: 'approved', transaction_amount: 1, date_created: '' }));
    return new Response(JSON.stringify({ paging: { total: inWin.length, limit: lim, offset: off }, results }), { status: 200 });
  };
  const got = await fetchPaymentsUpdatedBetween('tok', new Date('2026-09-18T03:00:00Z'), new Date('2026-09-19T03:00:00Z'));
  const ids = new Set(got.map((g) => g.id));
  check(`2.300 pagamentos num dia: ${got.length} coletados, sem duplicatas, ${calls} chamadas (janela dividida)`, got.length === 2300 && ids.size === 2300);

  // ---------------- 5. Ordem dos hooks: operador antes de admin ----------------
  const app = Fastify();
  const order: string[] = [];
  await app.register(async (s) => {
    s.addHook('preHandler', async (req: any) => { order.push('operator'); req.operator = { role: 'analyst' }; });
    s.post('/x', { preHandler: async (req: any, reply) => { order.push('admin'); if (req.operator?.role !== 'admin') return reply.code(403).send({ error: 'admin_only' }); } }, async () => ({ ok: true }));
  });
  const r = await app.inject({ method: 'POST', url: '/x' });
  check(`hooks: ${order.join(' -> ')}; analista recebe ${r.statusCode}`, order.join(',') === 'operator,admin' && r.statusCode === 403);

  console.log(`\n${pass} passaram, ${fail} falharam`);
  process.exit(fail ? 1 : 0);
})();
