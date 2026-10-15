import type { Page } from 'playwright-core';
import { config } from '../config.js';
import type { Comprador, DadosSimulacao, ResultadoItau } from '../types.js';
import { RoboError } from './erros.js';
import { S } from './seletores.js';
import { brParaNumero, centavos, etapa, textoOuNull } from './utils.js';

/** Campos com máscara (jquery.mask / maskMoney): digitar tecla a tecla é mais fiel que fill(). */
const digitar = async (page: Page, sel: string, texto: string) => {
  await page.locator(sel).click();
  await page.locator(sel).fill('');
  await page.locator(sel).pressSequentially(texto, { delay: 15 });
};

async function preencherComprador(page: Page, sel: Record<keyof typeof S.form.c2, string>, c: Comprador) {
  await page.fill(sel.nome, c.nome);
  await digitar(page, sel.cpf, c.cpf);
  await page.fill(sel.nascimento, c.nascimento); // <input type=date> exige AAAA-MM-DD
  await digitar(page, sel.cep, c.cep);
  await digitar(page, sel.renda, centavos(c.rendaBruta));
  await digitar(page, sel.celular, c.celular);
  await page.fill(sel.email, c.email);
}

export async function preencherESimular(page: Page, d: DadosSimulacao): Promise<ResultadoItau> {
  await etapa('abrir-simulador', async () => {
    if (config.ITAU_URL_SIMULADOR) await page.goto(config.ITAU_URL_SIMULADOR, { waitUntil: 'domcontentloaded' });
    else await page.click(S.menu.simuladorIsolado);
    await page.waitForSelector(S.form.cpf);
  });

  await etapa('comprador-principal', async () => {
    const c = d.cliente;
    await preencherComprador(page, { nome: S.form.nome, cpf: S.form.cpf, nascimento: S.form.nascimento, cep: S.form.cep, renda: S.form.renda, celular: S.form.celular, email: S.form.email }, c);
    await page.selectOption(S.form.segmento, { label: c.segmento });
    await page.selectOption(S.form.estadoCivil, { label: c.estadoCivil });
    if (c.segundoComprador) {
      await page.click(S.form.somarSim);
      await preencherComprador(page, S.form.c2, c.segundoComprador);
    } else await page.click(S.form.somarNao);
  });

  await etapa('dados-financiamento', async () => {
    const o = d.operacao;
    await page.setChecked(S.form.funcionario, d.cliente.funcionarioItau);
    await page.selectOption(S.form.tipoImovel, { label: o.tipoImovel }); // as listas abaixo só habilitam depois do tipo de imóvel
    await page.selectOption(S.form.seguradora, { label: o.seguradora });
    await page.selectOption(S.form.sistema, { label: o.sistema });
    await page.click(o.taxa === 'prefixada' ? S.form.taxaPrefixada : S.form.taxaPoupanca);
    await page.setChecked(S.form.financiarItbi, o.financiarItbi);
    await digitar(page, S.form.valorImovel, centavos(o.valorImovel));
    await digitar(page, S.form.entrada, centavos(o.entrada));
    await page.fill(S.form.prazo, String(o.prazoMeses));
  });

  await etapa('simular', async () => {
    await page.click(S.form.simular);
    // O botão valida o formulário (bootstrap validator): se algo estiver inválido a tela de resultado nunca aparece.
    await page.waitForFunction((sel) => {
      const el = document.querySelector(sel);
      return !!el && /\d/.test(el.textContent ?? '') && !/R\$\s*0,00/.test(el.textContent ?? '');
    }, S.resultado.pronto);
  });

  return etapa('ler-resultado', async () => {
    const r = S.resultado;
    const primeira = brParaNumero(await textoOuNull(page, r.primeiraParcela));
    if (primeira == null) throw new RoboError('RESPOSTA_ILEGIVEL', 'Resultado da simulação não encontrado (layout mudou?)', false, 'ler-resultado');
    return {
      status: 'SIMULADO',
      prazoMeses: brParaNumero(await textoOuNull(page, r.prazo)),
      primeiraParcela: primeira,
      ultimaParcela: brParaNumero(await textoOuNull(page, r.ultimaParcela)),
      somatorioParcelas: brParaNumero(await textoOuNull(page, r.somatorio)),
      valorTotalFinanciado: brParaNumero(await textoOuNull(page, r.totalFinanciado)),
      sistema: await textoOuNull(page, r.sistema),
      seguradora: await textoOuNull(page, r.seguradora),
      linhaCredito: await textoOuNull(page, r.linhaCredito),
      taxaJuros: await textoOuNull(page, r.taxa),
      cet: await textoOuNull(page, r.cet),
      dataSimulacao: await textoOuNull(page, r.data),
    };
  });
}
