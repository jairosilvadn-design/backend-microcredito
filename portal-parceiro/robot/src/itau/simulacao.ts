import type { Page } from 'playwright-core';
import type { DadosSimulacao, ResultadoItau } from '../types.js';
import { RoboError } from './erros.js';
import { S } from './seletores.js';
import { brParaNumero, dataBR, etapa, textoOuNull } from './utils.js';

export async function preencherESimular(page: Page, d: DadosSimulacao): Promise<ResultadoItau> {
  await etapa('abrir-nova-proposta', async () => { await page.click(S.menu.novaProposta); await page.waitForSelector(S.form.cpf); });

  await etapa('preencher-formulario', async () => {
    await page.fill(S.form.cpf, d.cliente.cpf);
    await page.fill(S.form.nascimento, dataBR(d.cliente.nascimento));
    await page.fill(S.form.renda, d.cliente.rendaBruta.toFixed(2).replace('.', ','));
    await page.click(d.cliente.fgts ? S.form.fgtsSim : S.form.fgtsNao);
    if (d.cliente.fgts) await page.fill(S.form.fgtsValor, d.cliente.fgtsValor.toFixed(2).replace('.', ','));
    await page.fill(S.form.valorImovel, d.operacao.valorImovel.toFixed(2).replace('.', ','));
    await page.fill(S.form.valorFinanciamento, d.operacao.valorFinanciamento.toFixed(2).replace('.', ','));
    await page.selectOption(S.form.sistema, { label: d.operacao.sistema });
  });

  await etapa('enviar', async () => {
    await page.click(S.form.enviar);
    await page.waitForSelector(S.resultado.container, { state: 'visible' });
  });

  return etapa('ler-resultado', async () => {
    const statusBruto = (await textoOuNull(page, S.resultado.status))?.toUpperCase() ?? '';
    const status: ResultadoItau['status'] | null =
      /APROVAD/.test(statusBruto) ? 'APROVADO' : /RECUSAD|NEGAD|REPROVAD/.test(statusBruto) ? 'RECUSADO' : /AN[ÁA]LISE|PEND/.test(statusBruto) ? 'EM_ANALISE' : null;
    if (!status) throw new RoboError('RESPOSTA_ILEGIVEL', 'Status do Itaú não reconhecido (layout mudou?)', false, 'ler-resultado');
    return {
      status,
      valorAprovado: brParaNumero(await textoOuNull(page, S.resultado.valorAprovado)),
      taxaJurosAnual: brParaNumero(await textoOuNull(page, S.resultado.taxa)),
      numeroProposta: await textoOuNull(page, S.resultado.proposta),
      motivo: await textoOuNull(page, S.resultado.motivo),
    };
  });
}
