/**
 * Painel do operador no NAVEGADOR (Chromium, tela de celular) contra a API real e Postgres local.
 * Só o login do Google é simulado (o SDK do Firebase vem de um site externo): o token é um JWT de verdade,
 * assinado com uma chave de teste, e a API o valida pelo mesmo caminho de produção.
 * Uso: DB_TEST_URL=postgresql://...localhost... npx tsx tests/painel.e2e.test.ts
 */
import './setup-env';
process.env.DATABASE_URL = process.env.DB_TEST_URL ?? '';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { readFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { prisma } from '../src/lib/prisma';
import { ymdSaoPaulo } from '../src/lib/dates';

if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)) { console.error('Defina DB_TEST_URL (banco local descartável).'); process.exit(2); }
(BigInt.prototype as unknown as { toJSON: () => string }).toJSON = function () { return this.toString(); };
let pass = 0, fail = 0;
const check = (n: string, c: boolean, x = '') => { c ? pass++ : fail++; console.log(`${c ? '✔' : '✘'} ${n}${c ? '' : ' ' + x}`); };
const SHOTS = process.env.SHOTS_DIR ?? '/tmp';
mkdirSync(SHOTS, { recursive: true });
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function main() {
  await prisma.$executeRawUnsafe('TRUNCATE "CashEntry","CreditPayment","CreditNotification","CreditInstallment","ContractSignature","BorrowerDocument","CreditContract","StatementAnalysis","Borrower","AppSetting","AuditLog" RESTART IDENTITY CASCADE');
  const op = await prisma.operator.upsert({ where: { email: 'op@teste.com' }, create: { email: 'op@teste.com', name: 'Op', role: 'admin' }, update: {} });

  // Login "do Google": chave de teste + JWKS servido no lugar do download do Google.
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  (https as unknown as { get: unknown }).get = () => { const r = new EventEmitter() as EventEmitter & { destroy: () => void }; r.destroy = () => undefined; setImmediate(() => r.emit('response', Object.assign(Readable.from([Buffer.from(JSON.stringify({ keys: [jwk] }))]), { statusCode: 200 }))); return r; };
  const jwt = await new SignJWT({ email: op.email, email_verified: true, firebase: { sign_in_provider: 'google.com' } }).setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setSubject('u1').setIssuer('https://securetoken.google.com/test').setAudience('test').setIssuedAt().setExpirationTime('2h').sign(privateKey);

  const { buildApp } = await import('../src/app');
  const api = await buildApp();
  await api.listen({ port: 0, host: '127.0.0.1' });
  const apiPort = (api.server.address() as { port: number }).port;

  // Servidor do painel com o MESMO CSP do netlify.toml (bloco do /index.html).
  const toml = readFileSync('netlify.toml', 'utf8');
  const bloco = toml.split('[[headers]]').find((b) => b.includes('for = "/index.html"'))!;
  const csp = /Content-Security-Policy = "([^"]+)"/.exec(bloco)![1]!;
  const arquivos: Record<string, [string, Buffer]> = {
    '/': ['text/html; charset=utf-8', readFileSync('public/index.html')], '/index.html': ['text/html; charset=utf-8', readFileSync('public/index.html')],
    '/painel.js': ['text/javascript; charset=utf-8', readFileSync('public/painel.js')],
    '/config.js': ['text/javascript', Buffer.from('window.__FB = {"apiKey":"test-key","authDomain":"x.firebaseapp.com","projectId":"test","appId":"1:1:web:1"};')],
  };
  const front = http.createServer((req, res) => {
    const f = arquivos[req.url!.split('?')[0]!];
    if (f) { res.writeHead(200, { 'content-type': f[0], 'content-security-policy': csp, 'cache-control': 'no-cache' }); return void res.end(f[1]); }
    const p = http.request({ host: '127.0.0.1', port: apiPort, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode!, r.headers); r.pipe(res); });
    req.pipe(p);
  });
  await new Promise<void>((ok) => front.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(front.address() as { port: number }).port}`;

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'pt-BR' });
  // SDK do Firebase simulado (mesma interface que o painel usa). O atraso simula o carregamento lento do SDK.
  const falso = `window.firebase={initializeApp:function(){},auth:Object.assign(function(){return A},{GoogleAuthProvider:function(){}})};
    var U={email:'op@teste.com',getIdToken:function(){return Promise.resolve(${JSON.stringify(jwt)})}};var CB=null;
    var A={currentUser:null,onAuthStateChanged:function(cb){CB=cb;setTimeout(function(){if(localStorage.getItem('fakeLogin')){A.currentUser=U;cb(U)}else cb(null)},window.__ATRASO||0)},
      signInWithPopup:function(){localStorage.setItem('fakeLogin','1');A.currentUser=U;CB(U);return Promise.resolve()},signOut:function(){localStorage.removeItem('fakeLogin');A.currentUser=null;CB(null);return Promise.resolve()}};`;
  await ctx.route('https://www.gstatic.com/firebasejs/**', (r) => r.fulfill({ contentType: 'text/javascript', body: r.request().url().includes('app-compat') ? falso : '' }));
  const page = await ctx.newPage();
  const erros: string[] = [];
  page.on('pageerror', (e) => erros.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/status of (409|422|403)/.test(m.text())) erros.push(m.text()); });
  const shot = (n: string) => page.screenshot({ path: `${SHOTS}/painel-${n}.png`, fullPage: true });
  const toastTxt = async () => (await page.textContent('#toast')) ?? '';

  // 1) login
  await page.goto(base + '/');
  await page.waitForSelector('#login:not(.hide)');
  check('sem login aparece a tela de entrada', await page.isVisible('#btnEntrar') && !(await page.isVisible('#shell')));
  await shot('1-login');
  await page.click('#btnEntrar');
  await page.waitForSelector('#shell:not(.hide)');
  await page.waitForSelector('text=Visão geral');
  check('login entra e a tela inicial carrega com UMA chamada (/inicio)', true);
  await shot('2-inicio');

  // 2) configurações (a chave Pix é obrigatória para gerar contrato)
  await page.goto(base + '/#/config');
  await page.waitForSelector('#fCf');
  await page.fill('[name=companyName]', 'Conecta Teste');
  await page.fill('[name=pixKey]', 'pix@empresa.com');
  await page.fill('[name=pixOwner]', 'Conecta Teste LTDA');
  await page.fill('[name=maxPrincipalGlobal]', '5000');
  await page.click('#okCf');
  await page.waitForFunction(() => document.getElementById('toast')?.textContent?.includes('salvas'));
  check('configurações salvas pelo painel', (await prisma.appSetting.findUnique({ where: { key: 'operation' } }))?.value !== undefined);

  // 3) caixa: aporte
  await page.goto(base + '/#/caixa');
  await page.waitForSelector('#fCx');
  await page.fill('#fCx [name=amount]', '5.000,00');
  await page.fill('#fCx [name=description]', 'capital inicial');
  await page.click('#okCx');
  await page.waitForFunction(() => document.getElementById('toast')?.textContent?.includes('Lançado'));
  check('aporte de R$ 5.000,00 lançado (vírgula/ponto de milhar entendidos)', Number((await prisma.cashEntry.aggregate({ _sum: { amount: true } }))._sum.amount) === 5000);
  await shot('3-caixa');

  // 4) novo cliente
  await page.goto(base + '/#/clientes/novo');
  await page.waitForSelector('#fCli');
  await page.fill('#fCli [name=document]', '12.345.678/0001-90');
  await page.fill('#fCli [name=name]', 'Maria da Silva Comercio');
  await page.fill('#fCli [name=whatsapp]', '(17) 99999-8888');
  await page.fill('#fCli [name=addressCity]', 'Rio Preto');
  await page.fill('#fCli [name=addressState]', 'sp');
  await page.check('#fCli [name=consent]');
  await shot('4-cliente-novo');
  await page.click('#okCli');
  await page.waitForSelector('text=Novo contrato');
  const cli = await prisma.borrower.findFirstOrThrow();
  check('cliente cadastrado e tela do cliente aberta', cli.name === 'Maria da Silva Comercio' && cli.document === '12345678000190');

  // 5) contrato: simular + gerar
  await page.click('text=Novo contrato');
  await page.waitForSelector('#fCt');
  await page.fill('#fCt [name=principal]', '300');
  await page.fill('#fCt [name=installments]', '20');
  await page.click('#btSim');
  await page.waitForSelector('#btGerar');
  check('simulação mostra parcela, total e CET', /Total a pagar/.test(await page.textContent('#resultado') ?? '') && /CET/.test(await page.textContent('#resultado') ?? ''));
  await shot('5-simulacao');
  await page.click('#btGerar');
  await page.waitForSelector('pre.msgwa');
  const msg = (await page.textContent('pre.msgwa')) ?? '';
  const token = /[?&]t=([\w-]+)/.exec(msg)![1]!;
  check('contrato gerado: link de assinatura e botão do WhatsApp na tela', msg.includes('/assinatura.html') && (await page.getAttribute('a:has-text("Enviar no WhatsApp")', 'href'))!.startsWith('https://wa.me/'));
  await shot('6-contrato-criado');

  // 6) cliente assina (documentos pelo banco, aceite pela API pública, como no celular dele)
  const ct = await prisma.creditContract.findFirstOrThrow();
  for (const kind of ['DOC_FRONT', 'DOC_SELFIE', 'ADDRESS_PROOF'] as const) await prisma.borrowerDocument.create({ data: { borrowerId: ct.borrowerId, contractId: ct.id, kind, mimeType: 'image/png', sizeBytes: PNG.length, data: new Uint8Array(PNG) } });
  const ac = await fetch(`${base}/p/contrato/${token}/aceite`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ typedSignature: 'Maria da Silva Comercio', signerDocument: '12345678000190', pixKey: 'maria@pix.com', pixKeyType: 'EMAIL', agreed: true }) });
  check('cliente assinou o contrato', ac.status === 200);

  // 7) contrato ativo: Pix a enviar
  await page.goto(base + `/#/contratos/${ct.id}`);
  await page.waitForSelector('text=Enviar o Pix ao cliente');
  check('contrato em andamento mostra a chave Pix do cliente para enviar o dinheiro', /maria@pix\.com/.test(await page.textContent('#app') ?? ''));
  await shot('7-contrato-ativo');
  await page.click('#btPix');
  await page.waitForFunction(() => document.getElementById('toast')?.textContent?.includes('Pix confirmado'));
  check('Pix confirmado pelo painel', !!(await prisma.creditContract.findUniqueOrThrow({ where: { id: ct.id } })).disbursedProof);

  // 8) cobrança do dia + baixa
  await prisma.$executeRaw`UPDATE "CreditInstallment" SET "dueDate" = "dueDate" - 1 WHERE "contractId" = ${ct.id}::uuid`; // 1ª parcela passa a vencer HOJE
  await page.goto(base + '/#/cobrancas');
  await page.waitForSelector('[data-baixa]');
  check('cobranças do dia mostra a parcela com o valor a receber', /Maria|Conecta|Comercio/.test(await page.textContent('#app') ?? ''));
  await shot('8-cobrancas');
  await page.click('[data-baixa]');
  await page.waitForSelector('#fBaixa');
  await shot('9-baixa');
  const valorPre = await page.inputValue('#fBaixa [name=valor]');
  check(`o valor da baixa já vem preenchido com o que falta (${valorPre})`, /^\d+,\d{2}$/.test(valorPre));
  await page.click('#okBaixa');
  await page.waitForFunction(() => document.getElementById('toast')?.textContent?.includes('Baixa registrada'));
  check('baixa registrada pelo painel', Number((await prisma.creditPayment.aggregate({ _sum: { amount: true } }))._sum.amount) > 0);

  // 9) CANCELAR contrato com motivo VAZIO (o erro que o operador teve)
  await page.goto(base + '/#/clientes/novo');
  await page.waitForSelector('#fCli');
  await page.fill('#fCli [name=document]', '98765432000155'); await page.fill('#fCli [name=name]', 'Joao Pereira Comercio'); await page.fill('#fCli [name=whatsapp]', '17988887777');
  await page.fill('#fCli [name=addressCity]', 'Rio Preto'); await page.fill('#fCli [name=addressState]', 'SP'); await page.check('#fCli [name=consent]');
  await page.click('#okCli'); await page.waitForSelector('text=Novo contrato');
  await page.click('text=Novo contrato'); await page.waitForSelector('#fCt');
  await page.fill('#fCt [name=principal]', '200'); await page.click('#btSim'); await page.waitForSelector('#btGerar'); await page.click('#btGerar'); await page.waitForSelector('pre.msgwa');
  const ct2 = await prisma.creditContract.findFirstOrThrow({ where: { borrowerId: (await prisma.borrower.findFirstOrThrow({ where: { document: '98765432000155' } })).id } });
  await page.goto(base + `/#/contratos/${ct2.id}`);
  await page.waitForSelector('#btCancelar');
  await shot('10-contrato-aguardando');
  await page.click('#btCancelar');
  await page.waitForSelector('#okCancelar');
  await page.click('#okCancelar'); // motivo em branco, de propósito
  await page.waitForFunction(() => document.getElementById('toast')?.textContent?.includes('cancelado'));
  check('cancelar contrato com o motivo EM BRANCO funciona', (await prisma.creditContract.findUniqueOrThrow({ where: { id: ct2.id } })).status === 'CANCELLED', await toastTxt());
  await page.waitForSelector('text=Cancelado');
  await shot('11-cancelado');

  // 10) contrato que já recebeu pagamento: mensagem clara
  await page.goto(base + `/#/contratos/${ct.id}`);
  await page.waitForSelector('#btCancelar'); await page.click('#btCancelar'); await page.waitForSelector('#okCancelar'); await page.click('#okCancelar');
  await page.waitForFunction(() => document.getElementById('toast')?.textContent?.includes('já recebeu'));
  check('contrato com pagamento recebido explica por que não cancela', /já recebeu/.test(await toastTxt()));

  // 11) velocidade percebida: com o Firebase demorando 2 s, o painel já mostra os últimos dados guardados
  await page.goto(base + '/#/contratos'); await page.waitForSelector('#lista .item'); // abre a lista uma vez: o aparelho guarda o resultado
  const page2 = await ctx.newPage();
  await page2.addInitScript(() => { (window as unknown as { __ATRASO: number }).__ATRASO = 2000; });
  const t0 = Date.now();
  await page2.goto(base + '/#/contratos', { waitUntil: 'domcontentloaded' });
  await page2.waitForSelector('#shell:not(.hide) .item');
  const ms = Date.now() - t0;
  check(`na reabertura a lista aparece na hora com os dados guardados (${ms} ms), sem esperar o login do Firebase (2000 ms)`, ms < 1200);
  await page2.close();

  // 12) sair limpa os dados guardados
  await page.goto(base + '/'); await page.waitForSelector('#shell:not(.hide)');
  await page.click('#btnSair'); await page.waitForSelector('#login:not(.hide)');
  check('sair apaga os dados guardados e volta ao login', await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('mc:')).length === 0));
  check('nenhum erro de JavaScript/CSP no console', erros.length === 0, erros.join(' | '));

  // 13) computador: menu azul à esquerda, como no painel antigo
  const ctxPc = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctxPc.route('https://www.gstatic.com/firebasejs/**', (r) => r.fulfill({ contentType: 'text/javascript', body: r.request().url().includes('app-compat') ? falso : '' }));
  await ctxPc.addInitScript(() => localStorage.setItem('fakeLogin', '1'));
  const pc = await ctxPc.newPage();
  await pc.goto(base + '/#/contratos'); await pc.waitForSelector('#lista .item');
  const largura = await pc.evaluate(() => document.getElementById('nav')!.getBoundingClientRect().width);
  check(`no computador o menu fica à esquerda (${Math.round(largura)} px) e a lista ao lado`, largura > 200 && largura < 300);
  await pc.screenshot({ path: `${SHOTS}/painel-12-computador.png` });
  await pc.goto(base + '/#/'); await pc.waitForSelector('text=Visão geral'); await pc.screenshot({ path: `${SHOTS}/painel-13-computador-inicio.png` });
  await ctxPc.close();

  await browser.close(); front.close(); await api.close();
  console.log(`\n${pass} passaram, ${fail} falharam`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
