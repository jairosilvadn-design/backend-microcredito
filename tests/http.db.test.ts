/** Fluxo completo pelas rotas HTTP, em Postgres local descartável: criar contrato -> assinar (2 cliques) -> baixar -> telas. */
import './setup-env';
process.env.DATABASE_URL = process.env.DB_TEST_URL ?? '';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { prisma } from '../src/lib/prisma';
import { addDaysYmd, ymdSaoPaulo } from '../src/lib/dates';

if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)) { console.error('Defina DB_TEST_URL para um banco local descartável.'); process.exit(2); }
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () { return this.toString(); };

let pass = 0, fail = 0;
const check = (n: string, c: boolean, extra = '') => { c ? pass++ : fail++; console.log(`${c ? '✔' : '✘'} ${n}${c ? '' : ' ' + extra}`); };

async function main() {
  // Começa sempre do zero (o guarda acima garante que é um banco local descartável).
  await prisma.$executeRawUnsafe('TRUNCATE "CashEntry", "CreditPayment", "CreditNotification", "CreditInstallment", "ContractSignature", "BorrowerDocument", "CreditContract", "StatementAnalysis", "Borrower", "AppSetting", "AuditLog" RESTART IDENTITY CASCADE');
  const op = await prisma.operator.upsert({ where: { email: 'h@t.com' }, create: { email: 'h@t.com', name: 'H', role: 'admin' }, update: {} });
  // Login REAL, sem atalho: assina um token Firebase com uma chave de teste e serve o JWKS correspondente
  // no lugar da chamada ao Google (só o download das chaves públicas é simulado).
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  (https as unknown as { get: unknown }).get = () => {
    const req = new EventEmitter() as EventEmitter & { destroy: () => void };
    req.destroy = () => undefined;
    const res = Object.assign(Readable.from([Buffer.from(JSON.stringify({ keys: [jwk] }))]), { statusCode: 200 });
    setImmediate(() => req.emit('response', res));
    return req;
  };
  const idToken = await new SignJWT({ email: op.email, email_verified: true, firebase: { sign_in_provider: 'google.com' } })
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' }).setSubject('u1').setIssuer(`https://securetoken.google.com/${process.env.FIREBASE_PROJECT_ID}`)
    .setAudience(process.env.FIREBASE_PROJECT_ID!).setIssuedAt().setExpirationTime('1h').sign(privateKey);
  const { creditRoutes } = await import('../src/routes/credit.routes');
  const { signatureRoutes } = await import('../src/routes/signature.routes');
  const { runCreditDaily } = await import('../src/jobs/credit-daily.job');

  const app = Fastify({ logger: false });
  await app.register(multipart);
  await app.register(creditRoutes);
  await app.register(signatureRoutes);

  const j = async (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown) => {
    const r = await app.inject({ method, url, payload: payload as never, headers: url.startsWith('/p/') ? {} : { authorization: `Bearer ${idToken}` } });
    return { code: r.statusCode, body: r.json() as Record<string, any> };
  };

  await j('PUT', '/api/credito/config', { pixKey: 'pix@empresa', companyName: 'Empresa', maxPrincipalGlobal: 5000 });
  await j('POST', '/api/credito/caixa', { kind: 'APORTE', amount: 5000, description: 'capital inicial' });
  const cli = await j('POST', '/api/credito/clientes', {
    personType: 'PJ', document: '12345678000190', name: 'Maria da Silva Comercio', whatsapp: '17999998888', addressCity: 'Rio Preto', addressState: 'SP',
    segment: 'mercearia', consent: true,
  });
  check('cadastro do cliente', cli.code === 201, JSON.stringify(cli.body));

  // contrato longo (120 parcelas) -> antes estourava o tempo da transação
  const t0 = Date.now();
  const ct = await j('POST', '/api/credito/contratos', { borrowerId: cli.body.id, principal: 300, installments: 120, frequency: 'DAILY', firstDueDate: addDaysYmd(ymdSaoPaulo(), 1), ratePercent: 20 });
  check(`contrato de 120 parcelas gerado em ${Date.now() - t0} ms`, ct.code === 201, JSON.stringify(ct.body));
  const ct2 = await j('POST', '/api/credito/contratos', { borrowerId: cli.body.id, principal: 300, installments: 10, frequency: 'DAILY', firstDueDate: addDaysYmd(ymdSaoPaulo(), 1) });
  check('segundo contrato do mesmo cliente é recusado com mensagem clara', ct2.code === 409 && ct2.body.error === 'open_contract');

  const token = new URL(ct.body.link).searchParams.get('t')!;
  const c0 = await prisma.creditContract.findUniqueOrThrow({ where: { id: ct.body.id }, include: { borrower: true } });
  for (const kind of ['DOC_FRONT', 'DOC_SELFIE', 'ADDRESS_PROOF']) {
    await prisma.borrowerDocument.create({ data: { borrowerId: c0.borrowerId, contractId: c0.id, kind: kind as never, mimeType: 'image/png', sizeBytes: 1, data: new Uint8Array([1]) } });
  }
  const aceite = { typedSignature: 'Maria da Silva Comercio', signerDocument: '12345678000190', pixKey: 'maria@pix', pixKeyType: 'EMAIL', agreed: true };
  const [a1, a2] = await Promise.all([j('POST', `/p/contrato/${token}/aceite`, aceite), j('POST', `/p/contrato/${token}/aceite`, aceite)]);
  check(`assinatura em clique duplo: uma aceita (${a1.code}/${a2.code}), a outra é barrada`, [a1.code, a2.code].sort().join() === '200,410', JSON.stringify([a1.body, a2.body]));
  const saidas = await prisma.cashEntry.count({ where: { contractId: c0.id, kind: 'LIBERACAO' } });
  check('a liberação saiu do caixa uma única vez', saidas === 1);

  const det = await j('GET', `/api/credito/contratos/${ct.body.id}`);
  check('contrato ficou ACTIVE com 120 parcelas', det.body.status === 'ACTIVE' && det.body.installments.length === 120);

  // dia seguinte: sem mexer em nada, vencimento de hoje+1 ainda não conta como atraso
  const pid = det.body.installments[0].id;
  const baixa = await j('POST', `/api/credito/parcelas/${pid}/baixa`, {});
  check('baixa pela rota', baixa.code === 200 && baixa.body.settled === true, JSON.stringify(baixa.body));
  const baixa2 = await j('POST', `/api/credito/parcelas/${pid}/baixa`, {});
  check('baixa repetida volta mensagem de negócio (409), não "erro inesperado"', baixa2.code === 409 && baixa2.body.error === 'already_paid');
  const exc = await j('POST', `/api/credito/parcelas/${det.body.installments[1].id}/baixa`, { amount: 99999 });
  check('valor absurdo é recusado com explicação (422)', exc.code === 422 && /passa do que falta/.test(exc.body.message), JSON.stringify(exc.body));

  const [painel, gestor, resumo, cob, caixa] = await Promise.all([
    j('GET', '/api/credito/painel'), j('GET', '/api/credito/gestor'), j('GET', '/api/credito/resumo'), j('GET', '/api/credito/cobrancas'), j('GET', '/api/credito/caixa'),
  ]);
  check('painel, gestor, resumo, cobranças e caixa respondem 200', [painel, gestor, resumo, cob, caixa].every((r) => r.code === 200), JSON.stringify([painel.code, gestor.code, resumo.code, cob.code, caixa.code]));

  // as telas têm que concordar entre si
  const parcela = Number(det.body.installmentAmount);
  const aReceber = Number(det.body.totalPayable) - parcela;
  check(`"a receber" igual no painel (${painel.body.outstanding}), no gestor (${gestor.body.carteira.aReceber}) e no resumo (${resumo.body.carteira.aReceber})`,
    Math.abs(Number(painel.body.outstanding) - aReceber) < 0.05 && painel.body.outstanding === gestor.body.carteira.aReceber && Number(resumo.body.carteira.aReceber) === Number(painel.body.outstanding),
    `esperado ${aReceber}`);
  check(`"capital na rua" igual no painel (${painel.body.principalOut}), no gestor (${gestor.body.carteira.principalNaRua}) e no resumo (${resumo.body.capital.capitalNaRua})`,
    painel.body.principalOut === gestor.body.carteira.principalNaRua && Number(resumo.body.capital.capitalNaRua) === Number(painel.body.principalOut));
  check('caixa = 5000 - 300 + parcela paga', Math.abs(Number(caixa.body.saldo) - (5000 - 300 + parcela)) < 0.01, caixa.body.saldo);
  check('capital voltou + lucro = recebido (resumo)', Math.abs(Number(resumo.body.capital.principalRecuperado) + Number(resumo.body.resultado.jurosRecebidos) - Number(resumo.body.resultado.recebidoTotal)) < 0.02);

  // régua diária com contrato atrasado
  await prisma.$executeRaw`UPDATE "CreditInstallment" SET "dueDate" = "dueDate" - 40 WHERE "contractId" = ${c0.id}::uuid AND sequence BETWEEN 2 AND 3`;
  const stats = await runCreditDaily(app.log);
  check('régua diária roda sem erro', stats !== null, JSON.stringify(stats));
  const apos = await prisma.creditContract.findUniqueOrThrow({ where: { id: c0.id } });
  check('40 dias de atraso: contrato vira inadimplente e continua cobrável', apos.status === 'DEFAULTED');
  const cob2 = await j('GET', '/api/credito/cobrancas');
  check('contrato inadimplente continua aparecendo nas cobranças (antes sumia)', cob2.body.rows.some((r: any) => r.contractId === c0.id));
  const pay = await j('POST', `/api/credito/parcelas/${det.body.installments[1].id}/baixa`, {});
  check('contrato inadimplente aceita baixa (antes dava "contrato não está ativo")', pay.code === 200, JSON.stringify(pay.body));
  const apos2 = await prisma.creditContract.findUniqueOrThrow({ where: { id: c0.id } });
  check('ainda falta a parcela 3 (40 dias de atraso): continua inadimplente', apos2.status === 'DEFAULTED');
  const pay3 = await j('POST', `/api/credito/parcelas/${det.body.installments[2].id}/baixa`, {});
  const apos3 = await prisma.creditContract.findUniqueOrThrow({ where: { id: c0.id } });
  check('pagou todo o atraso: o contrato volta a ACTIVE e o cliente a ATIVO', pay3.code === 200 && apos3.status === 'ACTIVE' && (await prisma.borrower.findUniqueOrThrow({ where: { id: c0.borrowerId } })).status === 'ATIVO');

  const conf = await j('POST', '/api/credito/conferir');
  check(`conferência geral sem divergências (${conf.body.divergencias?.length})`, conf.code === 200 && conf.body.tudoCerto === true, JSON.stringify(conf.body));

  console.log(`\n${pass} passaram, ${fail} falharam`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
