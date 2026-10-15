import type { Page } from 'playwright-core';
import { config } from '../config.js';
import { RoboError } from './erros.js';
import { S } from './seletores.js';
import { etapa } from './utils.js';

export async function login(page: Page) {
  await etapa('login', async () => {
    await page.goto(config.ITAU_URL_LOGIN, { waitUntil: 'domcontentloaded' });
    await page.fill(S.login.usuario, config.ITAU_USUARIO);
    await page.fill(S.login.senha, config.ITAU_SENHA);
    await page.click(S.login.entrar);
    const vencedor = await Promise.race([
      page.waitForSelector(S.login.logado).then(() => 'ok' as const),
      page.waitForSelector(S.login.erro).then(() => 'erro' as const),
    ]);
    if (vencedor === 'erro') throw new RoboError('LOGIN_FALHOU', 'Credencial do correspondente recusada pelo portal', false, 'login');
    // 2FA/CAPTCHA: se o portal exigir, este fluxo precisa de tratamento específico (ver README, "Riscos").
  });
}

export async function logout(page: Page) {
  await page.click(S.sair, { timeout: 5_000 }).catch(() => undefined); // best effort: o contexto é descartado de qualquer forma
}
