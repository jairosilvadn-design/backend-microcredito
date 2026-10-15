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
  await etapa('login', async () => {
    let alerta: string | null = null;
    page.on('dialog', (d) => { alerta = d.message(); void d.dismiss().catch(() => undefined); });

    await page.goto(config.ITAU_URL_LOGIN, { waitUntil: 'domcontentloaded' });
    await page.fill(S.login.usuario, config.ITAU_USUARIO);
    await page.fill(S.login.senha, config.ITAU_SENHA);
    await page.click(S.login.entrar);

    const limite = Date.now() + config.ROBO_TIMEOUT_MS;
    for (;;) {
      if (alerta) throw new RoboError('LOGIN_FALHOU', 'Credencial do correspondente recusada pelo portal', false, 'login');
      if (/ChangePassword/i.test(page.url())) throw new RoboError('ACAO_HUMANA', 'O portal exige troca de senha: um humano precisa trocá-la e atualizar ITAU_SENHA', false, 'login');
      const logado = await page.evaluate(() => !!localStorage.getItem('SessionId')).catch(() => false); // navegando: tenta de novo
      if (logado) break;
      if (Date.now() > limite) throw new RoboError('TIMEOUT', 'Login não concluiu a tempo', true, 'login');
      await page.waitForTimeout(300);
    }
    await tratarModais(page);
  });
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
