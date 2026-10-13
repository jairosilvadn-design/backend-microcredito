/**
 * Teste ponta a ponta no NAVEGADOR (Chromium, tela de celular): página de assinatura + API real + Postgres local.
 * Uso: DB_TEST_URL=postgresql://...localhost... npx tsx tests/assinatura.e2e.test.ts
 */
import './setup-env';
process.env.DATABASE_URL = process.env.DB_TEST_URL ?? '';
import http from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { prisma } from '../src/lib/prisma';
import { addDaysYmd, ymdSaoPaulo, ymdToDbDate } from '../src/lib/dates';

if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL)) { console.error('Defina DB_TEST_URL (banco local descartável).'); process.exit(2); }
let pass = 0, fail = 0;
const check = (n: string, c: boolean, x = '') => { c ? pass++ : fail++; console.log(`${c ? '✔' : '✘'} ${n}${c ? '' : ' ' + x}`); };
const SHOTS = process.env.SHOTS_DIR ?? '/tmp';
mkdirSync(SHOTS, { recursive: true });

// PNG 1x1 válido
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function contrato(borrowerId: string, n: number) {
  const hoje = ymdSaoPaulo();
  const token = `tok${n}${'x'.repeat(40)}`;
  return prisma.creditContract.create({
    data: {
      number: `E2E-${n}`, borrowerId, principal: 300, ratePercent: 20, totalPayable: 360, frequency: 'DAILY', installmentsCount: 3, installmentAmount: 120,
      firstDueDate: ymdToDbDate(addDaysYmd(hoje, 1)), cetMonthly: 0.4, netToBorrower: 300, status: 'AWAITING_SIGNATURE', outstanding: 360,
      contractText: 'CONTRATO DE EMPRÉSTIMO\n\n1. PARTES ...\n', contractHash: 'abcdef1234567890abcdef', payToPixKey: 'pix@empresa',
      signature: { create: { token, expiresAt: new Date(Date.now() + 3600_000) } },
      installments: { createMany: { data: [1, 2, 3].map((s) => ({ sequence: s, dueDate: ymdToDbDate(addDaysYmd(hoje, s)), amountDue: 120 })) } },
    },
  }).then((c) => ({ c, token }));
}

async function main() {
  await prisma.$executeRawUnsafe('TRUNCATE "CashEntry","CreditPayment","CreditNotification","CreditInstallment","ContractSignature","BorrowerDocument","CreditContract","StatementAnalysis","Borrower","AppSetting","AuditLog" RESTART IDENTITY CASCADE');
  const { buildApp } = await import('../src/app');
  const api = await buildApp();
  await api.listen({ port: 0, host: '127.0.0.1' });
  const apiPort = (api.server.address() as { port: number }).port;

  // Mesmo CSP do netlify.toml, para provar que a página funciona COM ele.
  const toml = readFileSync('netlify.toml', 'utf8');
  const csp = /Content-Security-Policy = "([^"]+)"/.exec(toml)![1]!;
  const html = readFileSync('public/assinatura.html');
  const front = http.createServer((req, res) => {
    if (req.url!.startsWith('/assinatura.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': csp, 'referrer-policy': 'no-referrer', 'cache-control': 'no-store' });
      return void res.end(html);
    }
    const p = http.request({ host: '127.0.0.1', port: apiPort, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode!, r.headers); r.pipe(res); });
    req.pipe(p);
  });
  await new Promise<void>((ok) => front.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(front.address() as { port: number }).port}`;

  const b = await prisma.borrower.create({ data: { personType: 'PJ', document: '12345678000190', name: 'Maria da Silva Comercio', whatsapp: '+5517999999999', addressCity: 'Rio Preto', addressState: 'SP', segment: 'mercearia', status: 'LEAD' } });
  const A = await contrato(b.id, 1);

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'pt-BR' });
  const page = await ctx.newPage();
  const erros: string[] = [];
  page.on('pageerror', (e) => erros.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource: the server responded with a status of 410/.test(m.text())) erros.push(m.text()); }); // o 410 do link já usado é esperado

  // ---------- A) cliente NOVO: documentos + dados ----------
  await page.goto(`${base}/assinatura.html?t=${A.token}`);
  await page.waitForSelector('#conteudo:not(.hide)');
  check('mostra as condições (valor, parcelas, total)', /R\$\s*300,00/.test(await page.textContent('#condicoes') ?? '') && /3 diárias/.test(await page.textContent('#condicoes') ?? ''));
  check('cliente novo vê o formulário completo e NÃO o botão rápido', await page.isVisible('#completo') && !(await page.isVisible('#rapido')));
  check('começa com o botão Assinar desabilitado', await page.isDisabled('#btnAssinar'));
  await page.screenshot({ path: `${SHOTS}/1-cliente-novo.png`, fullPage: true });

  for (const k of ['DOC_FRONT', 'DOC_SELFIE', 'ADDRESS_PROOF']) {
    await page.setInputFiles(`#in-${k}`, { name: `${k}.png`, mimeType: 'image/png', buffer: PNG });
    await page.waitForFunction((id) => document.getElementById(id)?.textContent?.includes('Enviado'), `chip-${k}`);
  }
  check('os 3 documentos subiram pelo celular', (await prisma.borrowerDocument.count({ where: { contractId: A.c.id } })) === 3);
  await page.fill('#nome', 'Maria da Silva Comercio');
  await page.fill('#cpf', '12.345.678/0001-90');
  await page.fill('#pix', 'maria@pix.com');
  await page.selectOption('#pixTipo', 'EMAIL');
  check('Assinar continua travado até marcar o aceite', await page.isDisabled('#btnAssinar'));
  await page.check('#aceito');
  check('com tudo preenchido o botão Assinar libera', !(await page.isDisabled('#btnAssinar')));
  await page.screenshot({ path: `${SHOTS}/2-cliente-novo-preenchido.png`, fullPage: true });
  await page.click('#btnAssinar');
  await page.waitForSelector('#sucesso:not(.hide)');
  await page.screenshot({ path: `${SHOTS}/3-sucesso.png`, fullPage: true });
  const cA = await prisma.creditContract.findUniqueOrThrow({ where: { id: A.c.id } });
  check('contrato do cliente novo ficou ATIVO', cA.status === 'ACTIVE');
  const docsAntes = await prisma.borrowerDocument.count({ where: { borrowerId: b.id } });

  // ---------- B) cliente RECORRENTE: só o botão ----------
  await prisma.creditContract.update({ where: { id: A.c.id }, data: { status: 'PAID' } }); // quitou
  const B = await contrato(b.id, 2);
  await page.goto(`${base}/assinatura.html?t=${B.token}`);
  await page.waitForSelector('#conteudo:not(.hide)');
  check('recorrente vê só o botão Assinar (sem formulário, sem fotos)', await page.isVisible('#rapido') && !(await page.isVisible('#completo')));
  check('mostra a chave Pix anterior mascarada, nunca inteira', /\*\*\*/.test(await page.textContent('#pixRapido') ?? '') && !/maria@pix\.com/.test(await page.content()));
  check('o botão é o único campo de ação (texto "Assinar")', (await page.textContent('#btnRapido'))?.trim() === 'Assinar');
  await page.screenshot({ path: `${SHOTS}/4-recorrente.png`, fullPage: true });
  await page.click('#btnRapido');
  await page.waitForSelector('#sucesso:not(.hide)');
  await page.screenshot({ path: `${SHOTS}/5-recorrente-sucesso.png`, fullPage: true });
  const cB = await prisma.creditContract.findUniqueOrThrow({ where: { id: B.c.id }, include: { signature: true } });
  check('contrato recorrente ficou ATIVO com a chave Pix anterior', cB.status === 'ACTIVE' && cB.signature?.signerPixKey === 'maria@pix.com');
  check('nenhuma foto foi duplicada', (await prisma.borrowerDocument.count({ where: { borrowerId: b.id } })) === docsAntes);

  // ---------- C) link já usado / inválido ----------
  await page.goto(`${base}/assinatura.html?t=${B.token}`);
  await page.waitForSelector('#erro:not(.hide)');
  check('link já assinado mostra aviso claro (não deixa assinar de novo)', /já foi assinado/i.test(await page.textContent('#erroTexto') ?? ''));
  await page.goto(`${base}/assinatura.html?t=curto`);
  await page.waitForSelector('#erro:not(.hide)');
  check('link incompleto mostra aviso', /Link incompleto/.test(await page.textContent('#erroTitulo') ?? ''));
  check('nenhum erro de JavaScript/CSP no console', erros.length === 0, erros.join(' | '));

  await browser.close(); front.close(); await api.close();
  console.log(`\n${pass} passaram, ${fail} falharam`);
  await prisma.$disconnect();
  process.exit(fail ? 1 : 0);
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
