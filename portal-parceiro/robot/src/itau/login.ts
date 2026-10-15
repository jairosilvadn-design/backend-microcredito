import type { Page } from 'playwright-core';
import { config } from '../config.js';
import { RoboError } from './erros.js';
import { S } from './seletores.js';
import { etapa } from './utils.js';

/**
 * Como o portal funciona (util.js/header.js do Itaú): o login chama /api/Identity/Login/; em sucesso grava `SessionId` no
 * localStorage. Credencial errada = `alert("Usuário ou senha invalido.")`. `logonState != 0` redireciona para a troca de senha.
 */
export async function login(page: Page) {
  let alerta: string | null = null;
  let respLogin: number | null = null;
  page.on('dialog', (d) => { alerta = d.message(); void d.dismiss().catch(() => undefined); });
  page.on('response', (r) => { if (/Identity\/Login/i.test(r.url())) respLogin = r.status(); });

  /** Retrato seguro da tela (sem credenciais): endereço, título, avisos visíveis. */
  const diag = async () => {
    const textos = await page.evaluate(() => {
      const ver = (s: string) => Array.from(document.querySelectorAll(s)).filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 3);
      return { msgErro: ver('#msgErro'), msgUsuario: ver('#msgUsuario'), toast: ver('.toast-message'), modal: ver('.bootbox-body'), botao: (document.querySelector('#btnEntrar') as HTMLButtonElement | null)?.disabled ?? null };
    }).catch(() => ({}));
    return JSON.stringify({ url: page.url().split('?')[0], titulo: await page.title().catch(() => ''), loginHttp: respLogin, alerta, ...textos }).slice(0, 700);
  };

  try {
    await page.goto(config.ITAU_URL_LOGIN, { waitUntil: 'domcontentloaded' });
  } catch {
    throw new RoboError('PORTAL_INDISPONIVEL', 'Não foi possível abrir a página de login do portal (indisponível ou bloqueando o servidor do robô)', false, 'login-abrir', await diag());
  }
  try {
    await page.fill(S.login.usuario, config.ITAU_USUARIO);
    await page.fill(S.login.senha, config.ITAU_SENHA);
    await page.locator(S.login.usuario).blur(); // o portal valida o e-mail no blur
  } catch {
    throw new RoboError('SELETOR_NAO_ENCONTRADO', 'Campos de login não encontrados na página (o portal mudou ou abriu outra tela)', false, 'login-preencher', await diag());
  }
  await page.click(S.login.entrar).catch(() => { throw new RoboError('SELETOR_NAO_ENCONTRADO', 'Botão Entrar não encontrado', false, 'login-entrar', undefined); });

  const limite = Date.now() + Math.max(config.ROBO_TIMEOUT_MS, 45_000);
  for (;;) {
    if (alerta) throw new RoboError('LOGIN_FALHOU', 'Credencial do correspondente recusada pelo portal', false, 'login', await diag());
    if (/ChangePassword/i.test(page.url())) throw new RoboError('ACAO_HUMANA', 'O portal exige troca de senha: um humano precisa trocá-la e atualizar ITAU_SENHA', false, 'login', await diag());
    const logado = await page.evaluate(() => !!localStorage.getItem('SessionId')).catch(() => false); // navegando: tenta de novo
    if (logado) break;
    const aviso = await page.evaluate(() => ['#msgErro', '.toast-message', '.bootbox-body'].map((s) => Array.from(document.querySelectorAll(s)).filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => (e.textContent ?? '').trim()).join(' ')).join(' ').trim()).catch(() => '');
    if (aviso) throw new RoboError('LOGIN_FALHOU', 'O portal recusou o login e mostrou um aviso', false, 'login', await diag());
    if (Date.now() > limite) throw new RoboError('TIMEOUT', 'O login não concluiu a tempo', false /* nunca repetir login sozinho: risco de bloquear a conta */, 'login', await diag());
    await page.waitForTimeout(300);
  }
  await etapa('login-avisos', () => tratarModais(page));
}

/** Janelas (bootbox) que o portal abre após o login. Termo LGPD é aceite jurídico: o robô NÃO aceita por ninguém. */
export async function tratarModais(page: Page) {
  await page.waitForTimeout(1500);
  const modal = page.locator('.bootbox.modal.in, .bootbox.modal.show').first();
  if (!(await modal.count())) return;
  const titulo = (await modal.locator('.modal-title').first().innerText().catch(() => '')).toLowerCase();
  if (/certifica/.test(titulo)) await modal.locator('button[data-bb-handler=ok]').click(); // aviso de vencimento do CA300
  else if (/prote[cç][aã]o de dados|termo/.test(titulo)) throw new RoboError('ACAO_HUMANA', 'O portal exige aceite do Termo LGPD: um humano precisa aceitar no portal', false, 'login');
}

/** Usa a própria função do portal (EfetuarLogof, em util.js) para encerrar a sessão no servidor. Melhor esforço. */
export async function logout(page: Page) {
  await page.evaluate(() => (window as unknown as { EfetuarLogof?: () => void }).EfetuarLogof?.()).catch(() => undefined);
  await page.waitForTimeout(1000).catch(() => undefined);
}
