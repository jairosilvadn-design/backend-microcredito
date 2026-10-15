import type { Page } from 'playwright-core';
import { RoboError } from './erros.js';

/** Página em uso (definida por executar.ts) para o robô poder fotografar a tela, em texto, quando uma etapa falha. */
export let paginaAtiva: Page | null = null;
export const definirPaginaAtiva = (p: Page | null) => { paginaAtiva = p; };

/** Texto das janelas de aviso visíveis + endereço atual. Sem dados pessoais (não lê campos do formulário). */
async function retratoDaTela(): Promise<string> {
  if (!paginaAtiva) return '';
  const avisos = await paginaAtiva.evaluate(() => Array.from(document.querySelectorAll('.bootbox-body, .toast-message')).filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 3)).catch(() => []);
  return JSON.stringify({ url: paginaAtiva.url().split('?')[0], avisos });
}

/** Linha do erro do Playwright que diz qual ação/elemento falhou (sem o valor digitado). */
const resumoErro = (msg: string) => msg.split('\n').map((l) => l.trim()).filter((l) => /^(\w+\.\w+: |- waiting for|- locator|- element|- .*intercepts)/.test(l) || /Timeout/.test(l)).slice(0, 4).join(' | ').slice(0, 300);

/** Executa uma etapa convertendo timeouts/seletores ausentes em RoboError tipado. */
export const tempos: { etapa: string; ms: number }[] = []; // cronometragem de cada etapa (vai para o log)
export async function etapa<T>(nome: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try { const r = await fn(); tempos.push({ etapa: nome, ms: Date.now() - t0 }); return r; }
  catch (e) {
    tempos.push({ etapa: `${nome}(falhou)`, ms: Date.now() - t0 });
    if (e instanceof RoboError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    const detalhe = `${resumoErro(msg)} ${await retratoDaTela()}`.trim();
    if (/Timeout|timeout/.test(msg)) throw new RoboError('TIMEOUT', `Tempo esgotado na etapa "${nome}"`, true, nome, detalhe);
    if (/waiting for (locator|selector)|strict mode violation/.test(msg)) throw new RoboError('SELETOR_NAO_ENCONTRADO', `Elemento não encontrado na etapa "${nome}"`, false, nome, detalhe);
    if (/net::|ECONN|ERR_/.test(msg)) throw new RoboError('PORTAL_INDISPONIVEL', `Portal indisponível na etapa "${nome}"`, true, nome, detalhe);
    throw new RoboError('ERRO_INESPERADO', `Falha inesperada na etapa "${nome}"`, false, nome, `${msg.split('\n')[0].slice(0, 220)} ${await retratoDaTela()}`.trim());
  }
}

/** Se o portal abriu uma janela de aviso/regra (bootbox), devolve o texto; senão null. */
export async function avisoDoPortal(page: Page): Promise<string | null> {
  await page.waitForTimeout(120);
  const t = await page.evaluate(() => Array.from(document.querySelectorAll('.bootbox.modal .bootbox-body')).filter((e) => (e as HTMLElement).offsetParent !== null).map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ')).catch(() => '');
  return t || null;
}

export const brParaNumero = (t?: string | null): number | null => {
  if (!t) return null;
  const n = Number(t.replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};

/** 8000.5 -> "800050": máscara de dinheiro do portal recebe os dígitos em centavos. */
export const centavos = (v: number) => String(Math.round(v * 100));

export async function textoOuNull(page: Page, sel: string) {
  const l = page.locator(sel).first();
  return (await l.count()) ? (await l.innerText()).trim() : null;
}

/** Espera a tela desejada. Se aparecer a tela de login no lugar, a sessão salva venceu (ou foi derrubada): sinaliza para refazer o login. */
export async function esperarTelaOuLogin(page: Page, seletorTela: string) {
  const pTela = page.waitForSelector(seletorTela, { state: 'attached' }).then(() => 'tela' as const);
  const pLogin = page.waitForSelector('#txtUsuario', { state: 'visible' }).then(() => 'login' as const);
  pTela.catch(() => undefined); pLogin.catch(() => undefined); // a que perder a corrida será cancelada ao fechar a página
  const vencedor = await Promise.race([pTela, pLogin]);
  if (vencedor === 'login') throw new RoboError('SESSAO_EXPIRADA', 'Sessão do portal expirada', false, 'sessao');
}

/** A página do Itaú roda um código de inicialização que ZERA alguns campos (ex.: nome/CPF). Esperamos ele terminar antes de preencher. */
export async function paginaPronta(page: Page) {
  await page.waitForLoadState('load').catch(() => undefined);
  await page.waitForFunction(() => { const j = (window as unknown as { jQuery?: { isReady?: boolean } }).jQuery; return j ? j.isReady === true : true; }, undefined, { timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(500); // deixa terminar os handlers assíncronos do "ready"
}
