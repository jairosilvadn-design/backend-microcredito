import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { config } from '../config.js';
import { log } from '../logger.js';
import type { DadosProposta, DadosSimulacao } from '../types.js';
import { RoboError } from './erros.js';
import { login } from './login.js';
import { enviarProposta } from './proposta.js';
import { simulacaoRapida } from './simulacao.js';
import { definirPaginaAtiva, tempos } from './utils.js';

type Opts = { browser?: Browser; executablePath?: string; args?: string[] };
type Estado = Awaited<ReturnType<BrowserContext['storageState']>>;

// Velocidade: o navegador fica aberto e a sessão do portal (cookies + localStorage) é reaproveitada entre as tarefas, só em memória.
// Cada tarefa continua tendo um CONTEXTO LIMPO (nada de dados de um cliente vaza para o outro); só o login do correspondente é reaproveitado.
let navegador: Browser | null = null;
let sessaoSalva: Estado | null = null;

async function obterNavegador(opts: Opts): Promise<Browser> {
  if (opts.browser) return opts.browser;
  if (!navegador || !navegador.isConnected()) navegador = await chromium.launch({ headless: config.HEADLESS === 'true', executablePath: opts.executablePath, args: opts.args });
  return navegador;
}

/** Não baixa o que o robô não usa (imagens, fontes, estatísticas, PDF de exemplo que a página tenta buscar em site externo). */
async function pouparBanda(context: BrowserContext) {
  await context.route('**/*', (route) => {
    const r = route.request();
    if (['image', 'font', 'media'].includes(r.resourceType()) || /pdf995\.com|google-analytics|googletagmanager|doubleclick|facebook\.net/.test(r.url())) return route.abort();
    return route.continue();
  });
}

async function tentar<T>(fn: (page: Page) => Promise<T>, opts: Opts, usarSessao: boolean): Promise<T> {
  const browser = await obterNavegador(opts);
  const context = await browser.newContext({ locale: 'pt-BR', viewport: { width: 1366, height: 800 }, storageState: usarSessao && sessaoSalva ? sessaoSalva : undefined });
  context.setDefaultTimeout(config.ROBO_TIMEOUT_MS);
  context.setDefaultNavigationTimeout(config.ROBO_TIMEOUT_MS);
  await pouparBanda(context);
  const page = await context.newPage();
  definirPaginaAtiva(page);
  try {
    if (!(usarSessao && sessaoSalva)) await login(page);
    const r = await fn(page);
    sessaoSalva = await context.storageState(); // guarda a sessão válida para a próxima tarefa
    return r;
  } catch (e) {
    if (process.env.DEBUG_SCREENSHOTS === '1') await page.screenshot({ path: `/tmp/erro-${Date.now()}.png` }).catch(() => undefined);
    if (e instanceof RoboError && e.codigo === 'LOGIN_FALHOU') sessaoSalva = null;
    throw e;
  } finally {
    definirPaginaAtiva(null);
    await context.close().catch(() => undefined);
  }
}

export async function comSessao<T>(fn: (page: Page) => Promise<T>, opts: Opts): Promise<T> {
  tempos.length = 0; const t0 = Date.now();
  try {
    try { return await tentar(fn, opts, true); }
    catch (e) {
      if (!(e instanceof RoboError && e.codigo === 'SESSAO_EXPIRADA')) throw e;
      sessaoSalva = null; tempos.push({ etapa: 'sessao-expirada', ms: 0 });
      return await tentar(fn, opts, false); // refaz com login novo (uma vez)
    }
  } finally {
    log.info(`tempos: total=${Date.now() - t0}ms ${tempos.map((t) => `${t.etapa}=${t.ms}`).join(' ')}`);
  }
}

export const executarSimulacao = (dados: DadosSimulacao, opts: Opts = {}) => comSessao((page) => simulacaoRapida(page, dados), opts);
export const executarProposta = (dados: DadosProposta, scrRegistrado: boolean, opts: Opts = {}) => comSessao((page) => enviarProposta(page, dados, scrRegistrado), opts);
