/** Mede o tempo das telas com carteira grande. Uso: DB_TEST_URL=postgresql://localhost... tsx tests/perf.seed.ts */
import './setup-env';
process.env.DATABASE_URL = process.env.DB_TEST_URL ?? '';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { prisma } from '../src/lib/prisma';
import { addDaysYmd, ymdSaoPaulo, ymdToDbDate } from '../src/lib/dates';
if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)) process.exit(2);
const N = Number(process.env.N ?? 500);
async function main() {
  const hoje = ymdSaoPaulo();
  await prisma.$executeRawUnsafe('TRUNCATE "CashEntry","CreditPayment","CreditNotification","CreditInstallment","ContractSignature","BorrowerDocument","CreditContract","StatementAnalysis","Borrower","AppSetting","AuditLog" RESTART IDENTITY CASCADE');
  const op = await prisma.operator.upsert({ where: { email: 'p@t.com' }, create: { email: 'p@t.com', name: 'P', role: 'admin' }, update: {} });
  const bs = Array.from({ length: N }, (_, i) => ({ personType: 'PJ' as const, document: `8${String(i).padStart(13, '0')}`, name: `Cliente ${i}`, whatsapp: '+5517999999999', addressCity: 'X', addressState: 'SP', segment: 'mercearia', status: 'ATIVO' as const }));
  await prisma.borrower.createMany({ data: bs });
  const borrowers = await prisma.borrower.findMany({ select: { id: true } });
  for (const [i, b] of borrowers.entries()) {
    const ini = -(i % 20);
    const c = await prisma.creditContract.create({ data: {
      number: `P-${i}`, borrowerId: b.id, principal: 300, ratePercent: 20, totalPayable: 360, frequency: 'DAILY', installmentsCount: 24, installmentAmount: 15,
      firstDueDate: ymdToDbDate(addDaysYmd(hoje, ini)), cetMonthly: 0.4, netToBorrower: 300, status: 'ACTIVE', outstanding: 360, contractText: 'x'.repeat(6000), contractHash: 'h', payToPixKey: 'p', disbursedAt: new Date(), disbursedProof: 'ok',
      installments: { createMany: { data: Array.from({ length: 24 }, (_, k) => ({ sequence: k + 1, dueDate: ymdToDbDate(addDaysYmd(hoje, ini + k)), amountDue: 15 })) } },
    }, include: { installments: true } });
    const pagas = c.installments.filter((x) => x.dueDate < ymdToDbDate(hoje)).slice(0, 12);
    for (const p of pagas) await prisma.creditPayment.create({ data: { installmentId: p.id, amount: 15, paidAt: new Date(), method: 'PIX' } });
  }
  await prisma.cashEntry.createMany({ data: Array.from({ length: 2000 }, (_, i) => ({ kind: 'RECEBIMENTO' as const, amount: 15, happenedAt: new Date(), description: 'x', contractId: null })) });
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  (https as any).get = () => { const r: any = new EventEmitter(); r.destroy = () => 0; setImmediate(() => r.emit('response', Object.assign(Readable.from([Buffer.from(JSON.stringify({ keys: [jwk] }))]), { statusCode: 200 }))); return r; };
  const tok = await new SignJWT({ email: op.email, email_verified: true, firebase: { sign_in_provider: 'google.com' } }).setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setSubject('u').setIssuer('https://securetoken.google.com/test').setAudience('test').setIssuedAt().setExpirationTime('1h').sign(privateKey);
  const { creditRoutes } = await import('../src/routes/credit.routes');
  const app = Fastify(); await app.register(multipart); await app.register(creditRoutes);
  console.log(`carteira: ${N} contratos, ${N * 24} parcelas`);
  for (const url of ['/api/credito/painel', '/api/credito/gestor', '/api/credito/resumo', '/api/credito/cobrancas', '/api/credito/contratos', '/api/credito/clientes', '/api/credito/caixa', '/api/credito/notificacoes']) {
    for (const rep of ['frio', 'repetido']) {
      const t = Date.now(); const r = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${tok}` } });
      console.log(`${url.padEnd(26)} ${rep.padEnd(9)} ${String(Date.now() - t).padStart(5)} ms  ${(r.rawPayload.length / 1024).toFixed(0).padStart(5)} KB  ${r.statusCode}`);
    }
  }
  await prisma.$disconnect(); process.exit(0);
}
main();
