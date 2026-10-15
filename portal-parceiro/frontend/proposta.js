// Tela "Enviar proposta → Isolado" (imóvel pronto). Campos, listas e regras copiados do portal (envio_proposta_isolado.html/.js).
// O envio ao banco é feito pelo robô; aqui o corretor preenche, revisa, declara o aceite do SCR do cliente e envia ao robô.
import { addDoc, collection, serverTimestamp, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { propostaOpcoes as O, TEXTO_SCR, VALOR_MIN_IMOVEL_PROPOSTA, ENTRADA_MIN_PERCENTUAL, PRAZO_MAX_MESES, PRAZO_MIN_MESES, IDADE_PRAZO_MAX_MESES } from './opcoes.js';

const UFS = 'AC:Acre,AL:Alagoas,AP:Amapá,AM:Amazonas,BA:Bahia,CE:Ceará,DF:Distrito Federal,ES:Espírito Santo,GO:Goiás,MA:Maranhão,MT:Mato Grosso,MS:Mato Grosso do Sul,MG:Minas Gerais,PA:Pará,PB:Paraíba,PR:Paraná,PE:Pernambuco,PI:Piauí,RJ:Rio de Janeiro,RN:Rio Grande do Norte,RS:Rio Grande do Sul,RO:Rondônia,RR:Roraima,SC:Santa Catarina,SP:São Paulo,SE:Sergipe,TO:Tocantins'.split(',').map((x) => x.split(':'));
const $ = (id) => document.getElementById(id);
const dig = (s) => (s ?? '').replace(/\D/g, '');
const brl = (v) => (v == null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const fv = (id) => document.getElementById(`f_${id}`);
const sim = (name) => document.querySelector(`input[name=pr_${name}]:checked`)?.value === 'sim';

// ---------- validações (mesmas do portal) ----------
function cpfOk(c) { if (!/^\d{11}$/.test(c) || /^(\d)\1{10}$/.test(c)) return false; const d = (n) => { let s = 0; for (let i = 0; i < n; i++) s += +c[i] * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; }; return d(9) === +c[9] && d(10) === +c[10]; }
function cnpjOk(raw) { // CNPJ numérico ou alfanumérico (cnpj.js do portal)
  const v = raw.replace(/[.\-/]/g, '').toUpperCase(); if (!/^[0-9A-Z]{12}[0-9]{2}$/.test(v)) return false;
  const val = [...v].map((ch) => (/\d/.test(ch) ? +ch : ch.charCodeAt(0) - 48));
  const dv = (arr) => { let p = 2, s = 0; for (let i = arr.length - 1; i >= 0; i--) { s += arr[i] * p; p = p === 9 ? 2 : p + 1; } const r = s % 11; return r < 2 ? 0 : 11 - r; };
  const d1 = dv(val.slice(0, 12)); const d2 = dv([...val.slice(0, 12), d1]); return d1 === val[12] && d2 === val[13];
}
const maiorIdade = (iso) => { const [a, m, d] = iso.split('-').map(Number); const h = new Date(); return new Date(h.getFullYear() - 18, h.getMonth(), h.getDate()) >= new Date(a, m - 1, d); };
const mesesDesde = (iso) => { const [a, m] = iso.split('-').map(Number); const h = new Date(); return (h.getFullYear() - a) * 12 + (h.getMonth() + 1 - m); };

// ---------- especificação do formulário ----------
const money = { mask: 'money' }, cpf = { mask: 'cpf' }, cep = { mask: 'cep' }, tel = { mask: 'tel' };
const comp = (p) => [ // bloco de pessoa (principal / 2º comprador)
  { id: `${p}nome`, label: 'Nome completo*', req: true }, { id: `${p}nasc`, label: 'Data de nascimento*', type: 'date', req: true }, { id: `${p}cpf`, label: 'CPF*', req: true, ...cpf },
  { id: `${p}cep`, label: 'CEP*', req: true, ...cep }, { id: `${p}end`, label: 'Endereço residencial*', req: true }, { id: `${p}bairro`, label: 'Bairro*', req: true },
  { id: `${p}cidade`, label: 'Cidade*', req: true }, { id: `${p}uf`, label: 'Estado*', req: true, opts: UFS },
  { id: `${p}renda`, label: 'Renda bruta total mensal*', req: true, ...money }, { id: `${p}tipoRenda`, label: 'Tipo de renda*', req: true, opts: O.tipoRenda },
  { id: `${p}cnpj`, label: 'CNPJ da empresa*', mask: 'cnpj', showIf: () => fv(`${p}tipoRenda`).value === 'Socio_Proprietario', req: true },
  { id: `${p}email`, label: 'E-mail*', type: 'email', req: true }, { id: `${p}tel`, label: 'Telefone*', req: true, ...tel },
];
const SECOES = [
  { t: 'Dados do financiamento', campos: [
    { id: 'tipoImovel', label: 'Tipo de imóvel*', req: true, opts: O.tipoImovel }, { id: 'estadoImovel', label: 'Localização do imóvel*', req: true, opts: UFS },
    { id: 'valorImovel', label: 'Valor do imóvel (R$)*', req: true, ...money }, { id: 'entrada', label: 'Valor da entrada (R$)*', req: true, ...money },
    { id: 'prazo', label: 'Prazo de financiamento (meses)*', req: true, type: 'number' }, { id: 'seguradora', label: 'Seguradora*', req: true, opts: O.seguradora },
    { id: 'sistema', label: 'Sistema de amortização*', req: true, opts: O.sistema } ] },
  { t: 'Taxa e custos', radios: [{ name: 'taxa', label: 'Taxa do financiamento*', opts: [['STANDARD', 'Taxa pré-fixada'], ['SAVINGS', 'Taxa poupança']], padrao: 'STANDARD' }],
    campos: [{ id: 'financiarItbi', label: 'Financiar ITBI e custos com cartório', type: 'checkbox' }, { id: 'percItbi', label: 'Custo ITBI e cartório (%)', showIf: () => fv('financiarItbi').checked, placeholder: 'ex.: 5' },
      { id: 'financiarAvaliacao', label: 'Financiar tarifa de avaliação do imóvel', type: 'checkbox' }] },
  { t: 'Dados pessoais do comprador', campos: [...comp('p_'), { id: 'p_estadoCivil', label: 'Estado civil*', req: true, opts: O.estadoCivil }],
    radios: [{ name: 'uniao', label: 'O cliente convive em união estável?*', opts: [['sim', 'Sim'], ['nao', 'Não']], padrao: 'nao', showIf: () => fv('p_estadoCivil').value && fv('p_estadoCivil').value !== 'MARRIED' }] },
  { t: 'Cônjuge', showIf: () => fv('p_estadoCivil').value === 'MARRIED' || (sim('uniao') && fv('p_estadoCivil').value !== 'MARRIED'), campos: [
    { id: 'c_nome', label: 'Nome completo do cônjuge*', req: true }, { id: 'c_cpf', label: 'CPF*', req: true, ...cpf }, { id: 'c_nasc', label: 'Data de nascimento*', type: 'date', req: true },
    { id: 'c_tel', label: 'Telefone*', req: true, ...tel }, { id: 'c_estadoCivil', label: 'Estado civil do cônjuge*', req: true, opts: O.estadoCivilConjuge, showIf: () => sim('uniao') } ] },
  { t: 'Composição de renda', radios: [{ name: 'compoe', label: 'O cliente irá compor renda?*', opts: [['sim', 'Sim'], ['nao', 'Não']], padrao: 'nao' }] },
  { t: '2º comprador', showIf: () => sim('compoe'), campos: [
    { id: 's_nome', label: 'Nome completo*', req: true }, { id: 's_estadoCivil', label: 'Estado civil*', req: true, opts: O.estadoCivil }, { id: 's_nasc', label: 'Data de nascimento*', type: 'date', req: true }, { id: 's_cpf', label: 'CPF*', req: true, ...cpf } ],
    radios: [{ name: 'mesmoEnd', label: 'O 2º comprador mora no mesmo endereço do 1º?*', opts: [['sim', 'Sim'], ['nao', 'Não']], padrao: 'sim' }],
    extra: [
      { id: 's_cep', label: 'CEP*', req: true, ...cep, showIf: () => !sim('mesmoEnd') }, { id: 's_end', label: 'Endereço residencial*', req: true, showIf: () => !sim('mesmoEnd') }, { id: 's_bairro', label: 'Bairro*', req: true, showIf: () => !sim('mesmoEnd') },
      { id: 's_cidade', label: 'Cidade*', req: true, showIf: () => !sim('mesmoEnd') }, { id: 's_uf', label: 'Estado*', req: true, opts: UFS, showIf: () => !sim('mesmoEnd') },
      { id: 's_renda', label: 'Renda bruta total mensal*', req: true, ...money }, { id: 's_tipoRenda', label: 'Tipo de renda*', req: true, opts: O.tipoRenda },
      { id: 's_cnpj', label: 'CNPJ da empresa*', mask: 'cnpj', req: true, showIf: () => fv('s_tipoRenda').value === 'Socio_Proprietario' },
      { id: 's_email', label: 'E-mail*', type: 'email', req: true }, { id: 's_tel', label: 'Telefone*', req: true, ...tel } ] },
  { t: 'PDV e canal', campos: [{ id: 'pdv', label: 'PDV (ponto de venda) vinculado à proposta*', req: true, placeholder: 'preenchido pelo administrador' }],
    radios: [{ name: 'canal', label: 'Deseja vincular essa proposta a um parceiro?*', opts: [['sim', 'Sim'], ['nao', 'Não']], padrao: 'nao' }],
    extra: [{ id: 'codigoItau', label: 'Código Itaú do parceiro*', req: true, showIf: () => sim('canal') }] },
  { t: 'Contato do parceiro', radios: [{ name: 'contato', label: 'Deseja ser o contato preferencial dessa proposta?*', opts: [['sim', 'Sim'], ['nao', 'Não']], padrao: 'sim' }],
    campos: [{ id: 'ct_nome', label: 'Nome*', req: true }, { id: 'ct_email', label: 'E-mail para contato*', type: 'email', req: true }, { id: 'ct_tel', label: 'Telefone para contato*', req: true, ...tel }] },
];

const mascaras = {
  money: (v) => { const d = dig(v); return d ? (Number(d) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : ''; },
  cpf: (v) => dig(v).slice(0, 11).replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2'),
  cep: (v) => dig(v).slice(0, 8).replace(/(\d{5})(\d)/, '$1-$2'),
  tel: (v) => dig(v).slice(0, 11).replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{5})(\d{1,4})$/, '$1-$2'),
  cnpj: (v) => { const x = v.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 14); return x.replace(/^(.{2})(.)/, '$1.$2').replace(/^(.{2}\..{3})(.)/, '$1.$2').replace(/^(.{2}\..{3}\..{3})(.)/, '$1/$2').replace(/^(.{2}\..{3}\..{3}\/.{4})(.)/, '$1-$2'); },
};

function campoEl(c) {
  const w = document.createElement('div'); w.dataset.campo = c.id; if (c.type === 'checkbox') w.style.gridColumn = '1/-1';
  const l = document.createElement('label'); l.className = 'l'; l.htmlFor = `f_${c.id}`;
  let inp;
  if (c.opts) { inp = document.createElement('select'); inp.append(new Option('Selecione', '')); c.opts.forEach(([v, t]) => inp.append(new Option(t, v))); }
  else { inp = document.createElement('input'); inp.type = c.type ?? 'text'; if (c.placeholder) inp.placeholder = c.placeholder; if (c.mask === 'money') inp.placeholder = 'R$ 0,00'; if (c.mask) inp.inputMode = c.mask === 'cnpj' ? 'text' : 'numeric'; }
  inp.id = `f_${c.id}`; inp.autocomplete = 'off';
  if (c.mask) inp.addEventListener('input', () => { inp.value = mascaras[c.mask](inp.value); });
  if (c.type === 'checkbox') { l.prepend(inp); l.append(' ' + c.label); w.append(l); } else { l.textContent = c.label; w.append(l, inp); }
  return w;
}
const radioEl = (r) => {
  const w = document.createElement('div'); w.dataset.radio = r.name; w.style.gridColumn = '1/-1';
  const l = document.createElement('label'); l.className = 'l'; l.textContent = r.label; const g = document.createElement('div'); g.className = 'inline';
  r.opts.forEach(([v, t]) => { const x = document.createElement('label'); const i = document.createElement('input'); i.type = 'radio'; i.name = `pr_${r.name}`; i.value = v; i.checked = v === r.padrao; x.append(i, ' ' + t); g.append(x); });
  w.append(l, g); return w;
};

export function iniciarProposta({ auth, db, getClaims, mostrar, carregando, perfil }) {
  const root = $('proposta-form'); const todos = [];
  for (const s of SECOES) {
    const sec = document.createElement('div'); sec.dataset.secao = s.t; const h = document.createElement('h3'); h.className = 'sec'; h.textContent = s.t; sec.append(h);
    const g = document.createElement('div'); g.className = 'grid'; sec.append(g);
    (s.radios ?? []).forEach((r) => { const e = radioEl(r); g.append(e); todos.push({ el: e, showIf: r.showIf }); });
    [...(s.campos ?? []), ...(s.extra ?? [])].forEach((c) => { const e = campoEl(c); g.append(e); todos.push({ el: e, showIf: c.showIf, c }); });
    todos.push({ el: sec, showIf: s.showIf }); root.append(sec);
  }
  const refresh = () => todos.forEach(({ el, showIf }) => { if (showIf) el.classList.toggle('hidden', !showIf()); });
  root.addEventListener('input', refresh); root.addEventListener('change', refresh); refresh();
  const f = (id) => $(`f_${id}`);
  const val = (id) => (f(id).type === 'checkbox' ? f(id).checked : f(id).value.trim());
  const visivel = (id) => !f(id).closest('[data-campo]').classList.contains('hidden') && !f(id).closest('[data-secao]').classList.contains('hidden');
  const num = (id) => Number(dig(f(id).value || '0')) / 100;

  // CEP → endereço (ViaCEP, público; o portal faz o mesmo e bloqueia a edição)
  for (const p of ['p_', 's_']) f(`${p}cep`).addEventListener('blur', async () => {
    const c = dig(f(`${p}cep`).value); if (c.length !== 8) return;
    try { const j = await (await fetch(`https://viacep.com.br/ws/${c}/json/`)).json(); if (j.erro) return; f(`${p}end`).value = j.logradouro ?? ''; f(`${p}bairro`).value = j.bairro ?? ''; f(`${p}cidade`).value = j.localidade ?? ''; f(`${p}uf`).value = j.uf ?? ''; } catch { /* digita à mão */ }
  });
  // Pré-preenche PDV e contato com o perfil da imobiliária (definido pelo administrador)
  const aplicaPerfil = () => { const p = perfil(); if (p.pdv) { f('pdv').value = p.pdv; f('pdv').readOnly = true; } if (!f('ct_email').value) f('ct_email').value = auth.currentUser?.email ?? ''; if (p.nome && !f('ct_nome').value) f('ct_nome').value = p.nome; };

  function coletar() {
    const pess = (p) => ({ nome: val(`${p}nome`), nascimento: val(`${p}nasc`), cpf: dig(val(`${p}cpf`)), cep: dig(val(`${p}cep`)), endereco: val(`${p}end`), bairro: val(`${p}bairro`), cidade: val(`${p}cidade`), uf: val(`${p}uf`), rendaBruta: num(`${p}renda`), tipoRenda: val(`${p}tipoRenda`), cnpj: visivel(`${p}cnpj`) ? val(`${p}cnpj`).replace(/[^0-9A-Z]/g, '') : '', email: val(`${p}email`), telefone: dig(val(`${p}tel`)) });
    const casadoOuUniao = $('f_p_estadoCivil').value === 'MARRIED' || sim('uniao');
    return {
      financiamento: { tipoImovel: val('tipoImovel'), estadoImovel: val('estadoImovel'), valorImovel: num('valorImovel'), entrada: num('entrada'), prazoMeses: Number(val('prazo')), seguradora: val('seguradora'), sistema: val('sistema'), taxa: document.querySelector('input[name=pr_taxa]:checked').value, financiarItbi: val('financiarItbi'), percentualItbi: val('financiarItbi') ? val('percItbi').replace(',', '.') : '', financiarAvaliacao: val('financiarAvaliacao') },
      principal: { ...pess('p_'), estadoCivil: val('p_estadoCivil'), uniaoEstavel: $('f_p_estadoCivil').value !== 'MARRIED' && sim('uniao') },
      conjuge: casadoOuUniao ? { nome: val('c_nome'), cpf: dig(val('c_cpf')), nascimento: val('c_nasc'), telefone: dig(val('c_tel')), estadoCivil: visivel('c_estadoCivil') ? val('c_estadoCivil') : '' } : null,
      compoeRenda: sim('compoe'),
      segundo: sim('compoe') ? { nome: val('s_nome'), estadoCivil: val('s_estadoCivil'), nascimento: val('s_nasc'), cpf: dig(val('s_cpf')), mesmoEndereco: sim('mesmoEnd'), cep: dig(val('s_cep')), endereco: val('s_end'), bairro: val('s_bairro'), cidade: val('s_cidade'), uf: val('s_uf'), rendaBruta: num('s_renda'), tipoRenda: val('s_tipoRenda'), cnpj: visivel('s_cnpj') ? val('s_cnpj').replace(/[^0-9A-Z]/g, '') : '', email: val('s_email'), telefone: dig(val('s_tel')) } : null,
      pdv: val('pdv'), canal: { vincularParceiro: sim('canal'), codigoItau: sim('canal') ? val('codigoItau') : '' },
      contato: { preferencial: sim('contato'), nome: val('ct_nome'), email: val('ct_email'), telefone: dig(val('ct_tel')) },
    };
  }

  function validar(d) {
    for (const el of root.querySelectorAll('[data-campo]')) { // obrigatórios visíveis
      const id = el.dataset.campo; const c = todos.find((t) => t.c?.id === id)?.c; if (!c?.req || !visivel(id)) continue;
      if (!f(id).value.trim()) return `Preencha: ${c.label.replace('*', '')}.`;
    }
    const pessoas = [['comprador', d.principal], ...(d.conjuge ? [['cônjuge', d.conjuge]] : []), ...(d.segundo ? [['2º comprador', d.segundo]] : [])];
    for (const [rot, p] of pessoas) {
      if (!cpfOk(p.cpf)) return `CPF do ${rot} inválido.`;
      if (!maiorIdade(p.nascimento)) return `O ${rot} deve ter 18 anos ou mais.`;
    }
    for (const [rot, p] of [['comprador', d.principal], ['2º comprador', d.segundo]]) { if (p?.cnpj && !cnpjOk(p.cnpj)) return `CNPJ do ${rot} inválido.`; if (p && p.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email)) return `E-mail do ${rot} inválido.`; if (p && !/^\d{10,11}$/.test(p.telefone)) return `Telefone do ${rot} inválido.`; }
    if (d.principal.cnpj === '' && d.principal.tipoRenda === 'Socio_Proprietario') return 'Informe o CNPJ do sócio proprietário.';
    const fi = d.financiamento; const min = VALOR_MIN_IMOVEL_PROPOSTA[fi.tipoImovel];
    if (min && fi.valorImovel < min) return `O Itaú financia imóvel ${fi.tipoImovel === 'RESIDENTIAL' ? 'residencial' : 'comercial'} a partir de ${brl(min)}.`;
    if (fi.entrada < (fi.valorImovel * ENTRADA_MIN_PERCENTUAL) / 100) return `A entrada deve ser de, no mínimo, ${ENTRADA_MIN_PERCENTUAL}% do valor do imóvel.`;
    const velho = [d.principal.nascimento, d.segundo?.nascimento].filter(Boolean).sort()[0];
    const maxPrazo = Math.min(PRAZO_MAX_MESES[fi.tipoImovel === 'RESIDENTIAL' ? 'RESIDENCIAL' : 'COMERCIAL'], IDADE_PRAZO_MAX_MESES - mesesDesde(velho));
    const minPrazo = fi.tipoImovel === 'RESIDENTIAL' && fi.sistema === 'HYBRID' ? 48 : PRAZO_MIN_MESES;
    if (!(fi.prazoMeses >= minPrazo && fi.prazoMeses <= maxPrazo)) return `O prazo deve ficar entre ${minPrazo} e ${maxPrazo} meses (sujeito à análise de crédito).`;
    return null;
  }

  // ---------- revisão + envio ----------
  let dadosRev = null; let unsub = null;
  $('proposta-revisar').onclick = () => {
    $('msg-prop').textContent = ''; const d = coletar(); const e = validar(d); if (e) { $('msg-prop').textContent = e; return; }
    dadosRev = d; const rev = $('revisao-corpo'); rev.replaceChildren();
    const linhas = [['Tipo de imóvel', O.tipoImovel.find((x) => x[0] === d.financiamento.tipoImovel)?.[1]], ['Localização', d.financiamento.estadoImovel], ['Valor do imóvel', brl(d.financiamento.valorImovel)], ['Entrada', brl(d.financiamento.entrada)], ['Valor a financiar', brl(d.financiamento.valorImovel - d.financiamento.entrada)], ['Prazo', d.financiamento.prazoMeses + ' meses'], ['Seguradora', d.financiamento.seguradora], ['Sistema', O.sistema.find((x) => x[0] === d.financiamento.sistema)?.[1]], ['Comprador', d.principal.nome], ['CPF', d.principal.cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')], ['Renda', brl(d.principal.rendaBruta)], ['Cônjuge', d.conjuge?.nome ?? '—'], ['Comporá renda', d.compoeRenda ? `Sim — ${d.segundo.nome}` : 'Não'], ['PDV', d.pdv]];
    const t = document.createElement('table'); t.className = 'det'; for (const [k, v] of linhas) { const r = t.insertRow(); r.insertCell().textContent = k; r.insertCell().textContent = v ?? '—'; } rev.append(t);
    $('scr-texto').textContent = TEXTO_SCR; $('scr-ok').checked = false; $('proposta-enviar').disabled = true; mostrar('tela-revisao');
  };
  $('scr-ok').onchange = () => { $('proposta-enviar').disabled = !$('scr-ok').checked; };
  $('proposta-voltar').onclick = () => mostrar('tela-proposta');
  $('proposta-enviar').onclick = async () => {
    if (!dadosRev || !$('scr-ok').checked) return;
    $('proposta-enviar').disabled = true; carregando(true, 'Enviando a proposta ao banco… pode levar alguns minutos. Não feche esta página.');
    try {
      const claims = await getClaims();
      const ref = await addDoc(collection(db, 'propostas'), {
        tipo: 'proposta', status: 'pendente', resultado: null, erro: null, tentativas: 0,
        corretorUid: auth.currentUser.uid, imobiliariaId: claims.imobiliariaId,
        cliente: { nome: dadosRev.principal.nome, cpf: dadosRev.principal.cpf }, operacao: { valorImovel: dadosRev.financiamento.valorImovel }, // resumo p/ listagens
        proposta: dadosRev,
        consentimentoScr: { aceito: true, uid: auth.currentUser.uid, email: auth.currentUser.email, texto: TEXTO_SCR, em: serverTimestamp() },
        criadoEm: serverTimestamp(),
      });
      unsub = onSnapshot(ref, (snap) => {
        const p = snap.data(); if (!p || ['pendente', 'processando'].includes(p.status)) return;
        unsub?.(); carregando(false); window.__renderPropostaResultado(p); mostrar('tela-proposta-resultado');
      });
    } catch (err) { carregando(false); $('proposta-enviar').disabled = false; $('msg-rev').textContent = 'Erro ao enviar: ' + err.code; }
  };
  $('proposta-revisar').closest('form')?.addEventListener('submit', (e) => e.preventDefault());
  return { aplicaPerfil, limpar: () => { root.closest('form').reset(); refresh(); aplicaPerfil(); } };
}
