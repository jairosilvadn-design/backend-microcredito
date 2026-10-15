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
export async function etapa<T>(nome: string, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof RoboError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    const detalhe = `${resumoErro(msg)} ${await retratoDaTela()}`.trim();
    if (/Timeout|timeout/.test(msg)) throw new RoboError('TIMEOUT', `Tempo esgotado na etapa "${nome}"`, true, nome, detalhe);
    if (/waiting for (locator|selector)|strict mode violation/.test(msg)) throw new RoboError('SELETOR_NAO_ENCONTRADO', `Elemento não encontrado na etapa "${nome}"`, false, nome, detalhe);
    if (/net::|ECONN|ERR_/.test(msg)) throw new RoboError('PORTAL_INDISPONIVEL', `Portal indisponível na etapa "${nome}"`, true, nome, detalhe);
    throw e;
  }
}

/** Se o portal abriu uma janela de aviso/regra (bootbox), devolve o texto; senão null. */
export async function avisoDoPortal(page: Page): Promise<string | null> {
  await page.waitForTimeout(350);
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
