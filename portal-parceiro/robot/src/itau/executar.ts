import { chromium, type Browser } from 'playwright-core';
import { config } from '../config.js';
import type { DadosSimulacao, ResultadoItau } from '../types.js';
import { login, logout } from './login.js';
import { preencherESimular } from './simulacao.js';

/** Abre um browser, roda o fluxo completo e SEMPRE fecha (finally). Um contexto limpo por proposta: sem vazar cookies/dados entre clientes. */
export async function executarSimulacao(
  dados: DadosSimulacao,
  opts: { browser?: Browser; executablePath?: string; args?: string[] } = {},
): Promise<ResultadoItau> {
  const dono = !opts.browser;
  const browser = opts.browser ?? await chromium.launch({ headless: config.HEADLESS === 'true', executablePath: opts.executablePath, args: opts.args });
  const context = await browser.newContext({ locale: 'pt-BR', viewport: { width: 1366, height: 800 } });
  context.setDefaultTimeout(config.ROBO_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(config.ROBO_TIMEOUT_MS);
  const page = await context.newPage();
  try {
    await login(page);
    const r = await preencherESimular(page, dados);
    await logout(page);
    return r;
  } catch (e) {
    // Screenshot só em ambiente de debug: ele contém dados do cliente (LGPD). Não envie para o Firestore.
    if (process.env.DEBUG_SCREENSHOTS === '1') await page.screenshot({ path: `/tmp/erro-${Date.now()}.png` }).catch(() => undefined);
    throw e;
  } finally {
    await context.close().catch(() => undefined);
    if (dono) await browser.close().catch(() => undefined);
  }
}
