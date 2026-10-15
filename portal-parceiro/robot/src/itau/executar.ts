import { chromium, type Browser } from 'playwright-core';
import { config } from '../config.js';
import type { DadosProposta, DadosSimulacao, ResultadoItau, ResultadoProposta } from '../types.js';
import { login, logout } from './login.js';
import { enviarProposta } from './proposta.js';
import { definirPaginaAtiva } from './utils.js';
import { preencherESimular } from './simulacao.js';

/** Abre um browser, roda o fluxo completo e SEMPRE fecha (finally). Um contexto limpo por proposta: sem vazar cookies/dados entre clientes. */
type Opts = { browser?: Browser; executablePath?: string; args?: string[] };

export const executarSimulacao = (dados: DadosSimulacao, opts: Opts = {}) => comSessao((page) => preencherESimular(page, dados), opts);
export const executarProposta = (dados: DadosProposta, scrRegistrado: boolean, opts: Opts = {}) => comSessao((page) => enviarProposta(page, dados, scrRegistrado), opts);

async function comSessao<T>(fn: (page: import('playwright-core').Page) => Promise<T>, opts: Opts): Promise<T> {
  const dono = !opts.browser;
  const browser = opts.browser ?? await chromium.launch({ headless: config.HEADLESS === 'true', executablePath: opts.executablePath, args: opts.args });
  const context = await browser.newContext({ locale: 'pt-BR', viewport: { width: 1366, height: 800 } });
  context.setDefaultTimeout(config.ROBO_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(config.ROBO_TIMEOUT_MS);
  const page = await context.newPage();
  definirPaginaAtiva(page);
  try {
    await login(page);
    const r = await fn(page);
    await logout(page);
    return r;
  } catch (e) {
    // Screenshot só em ambiente de debug: ele contém dados do cliente (LGPD). Não envie para o Firestore.
    if (process.env.DEBUG_SCREENSHOTS === '1') await page.screenshot({ path: `/tmp/erro-${Date.now()}.png` }).catch(() => undefined);
    throw e;
  } finally {
    definirPaginaAtiva(null);
    await context.close().catch(() => undefined);
    if (dono) await browser.close().catch(() => undefined);
  }
}
