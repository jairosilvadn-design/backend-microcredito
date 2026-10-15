import type { Page } from 'playwright-core';
import { RoboError } from './erros.js';

/** Executa uma etapa convertendo timeouts/seletores ausentes em RoboError tipado. */
export async function etapa<T>(nome: string, fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e) {
    if (e instanceof RoboError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (/Timeout|timeout/.test(msg)) throw new RoboError('TIMEOUT', `Tempo esgotado na etapa "${nome}"`, true, nome);
    if (/waiting for (locator|selector)|strict mode violation/.test(msg)) throw new RoboError('SELETOR_NAO_ENCONTRADO', `Elemento não encontrado na etapa "${nome}"`, false, nome);
    if (/net::|ECONN|ERR_/.test(msg)) throw new RoboError('PORTAL_INDISPONIVEL', `Portal indisponível na etapa "${nome}"`, true, nome);
    throw e;
  }
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
