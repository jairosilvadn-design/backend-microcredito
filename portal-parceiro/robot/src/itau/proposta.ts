import type { Page } from 'playwright-core';
import { config } from '../config.js';
import type { DadosProposta, PessoaProposta, ResultadoProposta } from '../types.js';
import { RoboError } from './erros.js';
import { S } from './seletores.js';
import { avisoDoPortal, centavos, etapa } from './utils.js';

const P = S.proposta;
const digitar = async (page: Page, sel: string, texto: string) => {
  const l = page.locator(sel); await l.click(); await l.fill(''); await l.pressSequentially(texto, { delay: 15 }); await l.blur();
  const aviso = await avisoDoPortal(page); // regra/erro de campo mostrado pelo portal em janela
  if (aviso) throw new RoboError('DADOS_INVALIDOS', `Portal recusou os dados: ${aviso}`, false, 'preencher');
};
const marcar = (page: Page, sel: string, valor = true) => page.locator(sel).evaluate((el, v) => { const i = el as HTMLInputElement; if (i.checked !== v) i.click(); }, valor); // clica pelo próprio código da página: funciona com input escondido
const escolher = (page: Page, sel: string, value: string) => page.selectOption(sel, { value });

/** Endereço: o portal consulta o CEP no blur e preenche rua/bairro/cidade/UF (campos bloqueados). Esperamos ele terminar. */
async function cep(page: Page, selCep: string, selEndereco: string, valor: string) {
  await digitar(page, selCep, valor);
  await page.waitForFunction((s) => !!(document.querySelector(s) as HTMLInputElement | null)?.value, selEndereco, { timeout: 15_000 })
    .catch(() => { throw new RoboError('DADOS_INVALIDOS', 'O portal não encontrou o endereço desse CEP', false, 'cep'); });
}

async function preencher(page: Page, d: DadosProposta) {
  const f = d.financiamento, p = d.principal;
  await etapa('proposta-financiamento', async () => {
    await page.focus(P.tipoImovel);
    await escolher(page, P.tipoImovel, f.tipoImovel); await escolher(page, P.estadoImovel, f.estadoImovel);
    await digitar(page, P.valorImovel, centavos(f.valorImovel)); await digitar(page, P.entrada, centavos(f.entrada));
    await page.fill(P.prazo, String(f.prazoMeses)); await escolher(page, P.seguradora, f.seguradora); await escolher(page, P.sistema, f.sistema);
    await marcar(page, f.taxa === 'STANDARD' ? P.taxaPadrao : P.taxaPoupanca);
    if (f.financiarItbi) { await marcar(page, P.financiarItbi); if (f.percentualItbi) await digitar(page, P.percentualItbi, f.percentualItbi); }
    if (f.financiarAvaliacao) await marcar(page, P.financiarAvaliacao);
  });
  await etapa('proposta-comprador', async () => {
    await page.fill(P.p.nome, p.nome); await page.fill(P.p.nasc, p.nascimento); await digitar(page, P.p.cpf, p.cpf);
    await cep(page, P.p.cep, P.p.endereco, p.cep);
    await digitar(page, P.p.renda, centavos(p.rendaBruta)); await escolher(page, P.p.tipoRenda, p.tipoRenda);
    if (p.cnpj) await digitar(page, P.p.cnpj, p.cnpj);
    await page.fill(P.p.email, p.email); await digitar(page, P.p.tel, p.telefone); await escolher(page, P.p.estadoCivil, p.estadoCivil);
    if (p.estadoCivil !== 'MARRIED') await marcar(page, p.uniaoEstavel ? P.p.uniaoSim : P.p.uniaoNao);
    if (d.conjuge) {
      await page.fill(P.c.nome, d.conjuge.nome); await digitar(page, P.c.cpf, d.conjuge.cpf); await page.fill(P.c.nasc, d.conjuge.nascimento); await digitar(page, P.c.tel, d.conjuge.telefone);
      if (d.conjuge.estadoCivil) await escolher(page, P.c.estadoCivil, d.conjuge.estadoCivil);
    }
  });
  await etapa('proposta-composicao-renda', async () => {
    if (!d.compoeRenda || !d.segundo) { await marcar(page, P.compoeNao); return; }
    const s = d.segundo; await marcar(page, P.compoeSim);
    await page.fill(P.s.nome, s.nome); await escolher(page, P.s.estadoCivil, s.estadoCivil); await page.fill(P.s.nasc, s.nascimento); await digitar(page, P.s.cpf, s.cpf);
    if (s.mesmoEndereco) await marcar(page, P.s.mesmoSim); else { await marcar(page, P.s.mesmoNao); await cep(page, P.s.cep, P.s.endereco, s.cep); }
    await digitar(page, P.s.renda, centavos(s.rendaBruta)); await escolher(page, P.s.tipoRenda, s.tipoRenda);
    if (s.cnpj) await digitar(page, P.s.cnpj, s.cnpj);
    await page.fill(P.s.email, s.email); await digitar(page, P.s.tel, s.telefone);
  });
  await etapa('proposta-pdv-canal-contato', async () => {
    const opcoes = await page.locator(`${P.pdv} option`).evaluateAll((os) => (os as HTMLOptionElement[]).map((o) => ({ v: o.value, t: o.textContent ?? '' })).filter((o) => o.v && o.v !== '-1'));
    if (opcoes.length) { // só existe para perfis Administrador/Corretor do portal
      const alvo = opcoes.find((o) => o.v === d.pdv || o.t.includes(d.pdv)) ?? (opcoes.length === 1 ? opcoes[0] : null);
      if (!alvo) throw new RoboError('DADOS_INVALIDOS', `PDV "${d.pdv}" não existe na conta do portal`, false, 'pdv');
      await page.selectOption(P.pdv, alvo.v);
    } else if (d.canal.vincularParceiro) { await marcar(page, P.canalSim); await page.fill(P.codigoItau, d.canal.codigoItau); } else await marcar(page, P.canalNao);
    await marcar(page, d.contato.preferencial ? P.contatoSim : P.contatoNao);
    await page.fill(P.contatoNome, d.contato.nome); await page.fill(P.contatoEmail, d.contato.email); await digitar(page, P.contatoTel, d.contato.telefone);
  });
}

/**
 * Preenche a tela de proposta e (somente com PROPOSTA_ENVIO_HABILITADO=true) confirma.
 * IDEMPOTÊNCIA: depois do clique em confirmar o robô NUNCA repete sozinho (evita proposta duplicada no banco).
 */
export async function enviarProposta(page: Page, d: DadosProposta, consentimentoScrRegistrado: boolean): Promise<ResultadoProposta> {
  await etapa('abrir-proposta', async () => {
    if (!config.ITAU_URL_PROPOSTA) throw new RoboError('DADOS_INVALIDOS', 'ITAU_URL_PROPOSTA não configurada no robô', false, 'abrir-proposta');
    await page.goto(config.ITAU_URL_PROPOSTA, { waitUntil: 'domcontentloaded' }); await page.waitForSelector(P.tipoImovel);
  });
  await preencher(page, d);

  await etapa('proposta-revisao', async () => {
    await page.click(P.avancar); // vai para a tela de confirmação do portal; se algum campo estiver inválido o portal mostra a regra
    await Promise.race([
      page.waitForSelector(P.confirmar, { state: 'visible' }),
      page.waitForSelector('.bootbox.modal .bootbox-body', { state: 'visible' }).then(async (el) => { throw new RoboError('DADOS_INVALIDOS', `Portal recusou os dados: ${(await el.innerText()).replace(/\s+/g, ' ').trim()}`, false, 'proposta-revisao'); }),
    ]);
  });

  if (config.PROPOSTA_ENVIO_HABILITADO !== 'true') return { status: 'PREENCHIDA', numeroProposta: null }; // modo de teste: para aqui
  if (!consentimentoScrRegistrado) throw new RoboError('ACAO_HUMANA', 'Aceite do SCR do cliente não registrado: proposta não enviada', false, 'scr');

  // Daqui em diante não há retentativa automática.
  try {
    await page.check(P.scr);
    const respP = page.waitForResponse((r) => r.request().method() === 'POST' && /ApiEnvioPropostaModernizado/i.test(r.url()), { timeout: config.ROBO_TIMEOUT_MS * 2 });
    respP.catch(() => undefined);
    await page.click(P.confirmar);
    const resp = await respP;
    const corpo = (await resp.text()).trim().replace(/^"|"$/g, '');
    if (/^\d+$/.test(corpo)) return { status: 'ENVIADA', numeroProposta: corpo };
    if (/CERTIFICACAO_C300_VENCIDA/.test(corpo)) throw new RoboError('ACAO_HUMANA', 'Certificado (CA300) vencido: o portal bloqueou o envio de propostas', false, 'enviar');
    if (/sess[aã]o/i.test(corpo)) throw new RoboError('ENVIO_INCERTO', 'Sessão do portal inválida durante o envio: confira no portal se a proposta foi criada antes de reenviar', false, 'enviar');
    throw new RoboError('DADOS_INVALIDOS', `Portal recusou a proposta: ${corpo.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200)}`, false, 'enviar');
  } catch (e) {
    if (e instanceof RoboError) throw e;
    throw new RoboError('ENVIO_INCERTO', 'Não foi possível confirmar se o banco recebeu a proposta: confira no portal do Itaú antes de reenviar', false, 'enviar');
  }
}
