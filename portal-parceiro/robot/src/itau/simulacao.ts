import type { Page } from 'playwright-core';
import { config } from '../config.js';
import type { Comprador, DadosSimulacao, ResultadoItau } from '../types.js';
import { RoboError } from './erros.js';
import { S } from './seletores.js';
import { centavos, etapa } from './utils.js';

/** Campos com máscara (jquery.mask / maskMoney): digitar tecla a tecla é mais fiel que fill(). */
const digitar = async (page: Page, sel: string, texto: string) => {
  await page.locator(sel).click();
  await page.locator(sel).fill('');
  await page.locator(sel).pressSequentially(texto, { delay: 15 });
  await page.locator(sel).blur(); // o portal consulta o CEP e valida CPF/renda no onblur
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
    await page.focus(S.form.nome); // o foco dispara o carregamento das listas (tipo de imóvel, seguradora, sistema)
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

  return etapa('simular-e-ler', async () => {
    const respostaP = page.waitForResponse((r) => r.request().method() === 'POST' && /EnviarSimulacaoModernizadaV2/i.test(r.url()), { timeout: config.ROBO_TIMEOUT_MS });
    // Regras do portal (idade, prazo, entrada mínima, valor mínimo do imóvel...) aparecem como janela (bootbox) ou alert nativo.
    const bootboxP = page.waitForSelector('.bootbox.modal .bootbox-body', { state: 'visible', timeout: config.ROBO_TIMEOUT_MS })
      .then((el) => el.innerText());
    const alertaP = new Promise<string>((res) => { page.once('dialog', (d) => { const m = d.message(); void d.dismiss().catch(() => undefined); res(m); }); });
    respostaP.catch(() => undefined); bootboxP.catch(() => undefined); // o perdedor da corrida não pode virar "unhandled rejection"

    await page.click(S.form.simular);
    const vencedor = await Promise.race([
      respostaP.then((r) => ({ tipo: 'resposta' as const, r })),
      bootboxP.then((t) => ({ tipo: 'regra' as const, t })),
      alertaP.then((t) => ({ tipo: 'regra' as const, t })),
    ]);
    if (vencedor.tipo === 'regra') throw new RoboError('DADOS_INVALIDOS', `Portal recusou os dados: ${vencedor.t.replace(/\s+/g, ' ').trim()}`, false, 'simular');

    const resp = vencedor.r;
    if (!resp.ok()) {
      const msg = (await resp.text().catch(() => '')).slice(0, 200);
      throw new RoboError(resp.status() >= 500 ? 'PORTAL_INDISPONIVEL' : 'DADOS_INVALIDOS', `Portal respondeu ${resp.status()}: ${msg}`, resp.status() >= 500, 'simular');
    }
    const j = await resp.json().catch(() => null) as Record<string, any> | null;
    if (!j || typeof j !== 'object' || j.period == null || j.firstInstallment == null) throw new RoboError('RESPOSTA_ILEGIVEL', 'Resposta da simulação em formato inesperado (portal mudou?)', false, 'ler-resultado');
    const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    return {
      status: 'SIMULADO',
      idSimulacao: j.idSimulation ?? null,
      dataSimulacao: j.dataSimulation ? String(j.dataSimulation) : null,
      prazoMeses: n(Number(j.period)),
      valorImovel: n(j.propertyPrice),
      entrada: n(j.downPayment),
      valorFinanciado: n(j.loanAmount),
      primeiraParcela: n(j.firstInstallment?.totalValue),
      ultimaParcela: n(j.lastInstallment?.totalValue),
      somatorioParcelas: n(j.installmentsTotalValue),
      sistema: String(j.amortizationType ?? '').toUpperCase() === 'HYBRID' ? 'MIX' : String(j.amortizationType ?? '').toUpperCase() || null,
      linhaCredito: j.financingType ? String(j.financingType).toUpperCase() : null,
      taxaJurosAnual: n(Number(j.annualRate)),
      cetAnual: n(j.cetAnnual),
      ceshAnual: n(j.ceshAnnual),
    } satisfies ResultadoItau;
  });
}
