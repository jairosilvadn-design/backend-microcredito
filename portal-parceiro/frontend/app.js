import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, signOut }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, doc, setDoc, getDoc, addDoc, collection, onSnapshot, serverTimestamp, query, where, orderBy, limit, getDocs }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';
import { marca } from './marca.js';
import { iniciarProposta } from './proposta.js';
import { opcoes, VALOR_MIN_IMOVEL, ENTRADA_MIN_PERCENTUAL, PRAZO_MAX_MESES, PRAZO_MIN_MESES, PRAZO_MIN_MIX_RESIDENCIAL, IDADE_PRAZO_MAX_MESES } from './opcoes.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const $ = (id) => document.getElementById(id);
const secoes = ['tela-pendente', 'tela-simulacao', 'tela-resultado', 'tela-historico', 'tela-proposta', 'tela-revisao', 'tela-proposta-resultado'];
const mostrar = (t) => {
  const logado = t !== 'login';
  $('tela-login').classList.toggle('hidden', logado);
  $('app').classList.toggle('hidden', !logado);
  secoes.forEach((x) => $(x).classList.toggle('hidden', x !== t));
  $('nav-sim').classList.toggle('ativo', t === 'tela-simulacao' || t === 'tela-resultado');
  $('nav-hist').classList.toggle('ativo', t === 'tela-historico');
  $('nav-prop').classList.toggle('ativo', ['tela-proposta', 'tela-revisao', 'tela-proposta-resultado'].includes(t));
  window.scrollTo(0, 0);
};
let timerCarregando = null; let dispensado = false;
const carregando = (on, txt) => {
  $('carregando').classList.toggle('hidden', !on); if (txt) $('carregando-txt').textContent = txt;
  clearTimeout(timerCarregando); $('carregando-fechar').classList.add('hidden');
  if (on) { dispensado = false; timerCarregando = setTimeout(() => $('carregando-fechar').classList.remove('hidden'), 20000); }
};
$('carregando-fechar').onclick = () => { dispensado = true; $('carregando').classList.add('hidden'); $('form-sim').querySelector('#enviar').disabled = false; carregarHistorico(); };
// Identidade visual (marca.js)
document.documentElement.style.setProperty('--cor', marca.cor);
document.documentElement.style.setProperty('--cor-clara', marca.corClara);
document.title = marca.nome;
document.querySelectorAll('[data-marca]').forEach((el) => { el.textContent = marca[el.dataset.marca]; });
$('rodape').textContent = marca.rodape;
if (marca.ajudaUrl) { $('ajuda').href = marca.ajudaUrl; $('ajuda').classList.remove('hidden'); }
const soDigitos = (s) => (s ?? '').replace(/\D/g, '');
let cadastro = false;
let unsubProposta = null;
let claimsAtuais = {};
let perfilAtual = {};

// ---------- Listas de seleção ----------
for (const [id, lista] of Object.entries({ estadoCivil: opcoes.estadoCivil, tipoImovel: opcoes.tipoImovel, seguradora: opcoes.seguradora, sistema: opcoes.sistema })) {
  const sel = $(id);
  sel.append(new Option('Selecione', ''));
  lista.forEach((t) => sel.append(new Option(t, t)));
}

// ---------- Máscaras ----------
const fmtBRL = (centavos) => (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const valor = (id) => Number(soDigitos($(id).value || '0')) / 100; // reais
const mascara = (sel, fn) => document.querySelectorAll(sel).forEach((el) => el.addEventListener('input', () => { el.value = fn(el.value); }));
mascara('[data-moeda]', (v) => { const d = soDigitos(v); return d ? fmtBRL(Number(d)) : ''; });
mascara('[data-cpf]', (v) => soDigitos(v).slice(0, 11).replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2'));
mascara('[data-cep]', (v) => soDigitos(v).slice(0, 8).replace(/(\d{5})(\d)/, '$1-$2'));
mascara('[data-cel]', (v) => soDigitos(v).slice(0, 11).replace(/(\d{2})(\d)/, '($1) $2').replace(/(\d{5})(\d{1,4})$/, '$1-$2'));

function cpfValido(cpf) {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  const dv = (n) => { let s = 0; for (let i = 0; i < n; i++) s += Number(cpf[i]) * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === Number(cpf[9]) && dv(10) === Number(cpf[10]);
}

const atualizaTotal = () => { $('total-fin').textContent = fmtBRL(Math.max(0, Math.round((valor('imovel') - valor('entrada')) * 100))); };
['imovel', 'entrada'].forEach((id) => $(id).addEventListener('input', atualizaTotal));

// ---------- Login / cadastro ----------
$('alternar').onclick = (e) => {
  e.preventDefault(); cadastro = !cadastro;
  $('campos-cadastro').classList.toggle('hidden', !cadastro);
  $('titulo-auth').textContent = cadastro ? 'Cadastro de parceiro' : 'Entrar';
  $('alternar').textContent = cadastro ? 'Já tenho conta' : 'Quero me cadastrar';
};

$('form-auth').onsubmit = async (e) => {
  e.preventDefault(); $('msg-auth').textContent = '';
  try {
    if (cadastro) {
      const c = await createUserWithEmailAndPassword(auth, $('email').value, $('senha').value);
      await setDoc(doc(db, 'parceiros', c.user.uid), {
        nome: $('nome').value, cnpj: soDigitos($('cnpj').value), email: $('email').value,
        status: 'pendente', criadoEm: serverTimestamp(),
      });
    } else {
      await signInWithEmailAndPassword(auth, $('email').value, $('senha').value);
    }
  } catch (err) { $('msg-auth').textContent = 'Não foi possível entrar/cadastrar: ' + err.code; }
};

$('sair').onclick = () => signOut(auth);
$('esqueci').onclick = async (e) => {
  e.preventDefault();
  if (!$('email').value) return ($('msg-auth').textContent = 'Digite seu e-mail e clique de novo em "Esqueceu sua senha?".');
  try { await sendPasswordResetEmail(auth, $('email').value); $('msg-auth').textContent = 'Enviamos um link para redefinir a senha, se o e-mail existir.'; }
  catch { $('msg-auth').textContent = 'Não foi possível enviar o e-mail agora.'; }
};

// Papel e aprovação vêm das custom claims do token (definidas só pelo admin).
onAuthStateChanged(auth, async (user) => {
  if (unsubProposta) { unsubProposta(); unsubProposta = null; }
  carregando(false);
  if (!user) return mostrar('login');
  const { claims } = await user.getIdTokenResult(true);
  claimsAtuais = claims;
  perfilAtual = (await getDoc(doc(db, 'parceiros', user.uid)).catch(() => null))?.data?.() ?? {};
  $('user-nome').textContent = user.email;
  const ok = !!claims.aprovado;
  ['nav-sim', 'nav-hist', 'nav-prop', 'nav-acomp'].forEach((id) => $(id).classList.toggle('hidden', !ok));
  if (ok) carregarHistorico(); else mostrar('tela-pendente');
});
$('nav-sim').onclick = () => mostrar('tela-simulacao');
$('nav-hist').onclick = () => carregarHistorico();
const prop = iniciarProposta({ auth, db, getClaims: async () => claimsAtuais, mostrar, carregando, perfil: () => perfilAtual });
$('nav-prop').onclick = () => { prop.aplicaPerfil(); mostrar('tela-proposta'); };

// ---------- Formulário ----------
const somar = () => document.querySelector('input[name=somar]:checked').value === 'sim';
document.querySelectorAll('input[name=somar]').forEach((r) => r.addEventListener('change', () => {
  const sim = somar();
  $('bloco-c2').classList.toggle('hidden', !sim);
  ['c2-nome', 'c2-cpf', 'c2-nasc', 'c2-cep', 'c2-renda', 'c2-cel', 'c2-email'].forEach((id) => { $(id).required = sim; });
}));

const comprador = (p) => ({
  nome: $(`${p}-nome`).value.trim(), cpf: soDigitos($(`${p}-cpf`).value), nascimento: $(`${p}-nasc`).value,
  cep: soDigitos($(`${p}-cep`).value), rendaBruta: valor(`${p}-renda`), celular: soDigitos($(`${p}-cel`).value), email: $(`${p}-email`).value.trim(),
});

function maiorDeIdade(iso) {
  const [a, m, d] = iso.split('-').map(Number);
  const hoje = new Date();
  return new Date(hoje.getFullYear() - 18, hoje.getMonth(), hoje.getDate()) >= new Date(a, m - 1, d);
}

const fmtR = (v) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
function mesesDesde(iso) {
  const [a, m] = iso.split('-').map(Number); const h = new Date();
  return (h.getFullYear() - a) * 12 + (h.getMonth() + 1 - m);
}

// Mesmas regras que o simulador do Itaú aplica na tela (o portal valida de novo ao simular).
function validar(c1, c2, op) {
  if (!cpfValido(c1.cpf)) return 'CPF do comprador principal inválido.';
  if (c2 && !cpfValido(c2.cpf)) return 'CPF do 2º comprador inválido.';
  if (!maiorDeIdade(c1.nascimento) || (c2 && !maiorDeIdade(c2.nascimento))) return 'O comprador deve ter 18 anos ou mais.';
  if (c1.rendaBruta <= 0 || (c2 && c2.rendaBruta <= 0)) return 'Informe a renda bruta mensal.';
  const minImovel = VALOR_MIN_IMOVEL[op.tipoImovel];
  if (minImovel && op.valorImovel < minImovel) return `Para imóvel ${op.tipoImovel.toLowerCase()}, o Itaú financia a partir de ${fmtR(minImovel)}.`;
  const entradaMin = (op.valorImovel * ENTRADA_MIN_PERCENTUAL) / 100;
  if (op.entrada < entradaMin) return `A entrada deve ser de, no mínimo, ${ENTRADA_MIN_PERCENTUAL}% do valor do imóvel (${fmtR(entradaMin)}). Você pode somar dinheiro e FGTS.`;
  // Com ITBI/cartório financiado, financiamento + ITBI (5% do imóvel) não pode chegar ao limite de 80% => entrada acima de 25% (regra do portal).
  if (op.financiarItbi && op.entrada <= op.valorImovel * 0.25) return `Para financiar o ITBI e os custos de cartório, a entrada precisa ser maior que 25% do valor do imóvel (${fmtR(op.valorImovel * 0.25)}). Aumente a entrada ou desmarque "Financiar ITBI".`;
  const mais_velho = c2 && c2.nascimento && c2.nascimento < c1.nascimento ? c2.nascimento : c1.nascimento;
  const maxPrazo = Math.min(PRAZO_MAX_MESES[op.tipoImovel] ?? 240, IDADE_PRAZO_MAX_MESES - mesesDesde(mais_velho));
  const minPrazo = op.tipoImovel === 'RESIDENCIAL' && op.sistema === 'MIX' ? PRAZO_MIN_MIX_RESIDENCIAL : PRAZO_MIN_MESES;
  if (maxPrazo < PRAZO_MIN_MESES) return 'A idade do comprador está fora do prazo de financiamento.';
  if (!(op.prazoMeses >= minPrazo && op.prazoMeses <= maxPrazo)) return `O prazo deve ficar entre ${minPrazo} e ${maxPrazo} meses (sujeito à análise de crédito).`;
  return null;
}

$('form-sim').onsubmit = async (e) => {
  e.preventDefault();
  const btn = $('enviar'); $('msg-sim').textContent = '';
  const c1 = comprador('c1'); const c2 = somar() ? comprador('c2') : null;
  const op = {
    tipoImovel: $('tipoImovel').value, seguradora: $('seguradora').value, sistema: $('sistema').value,
    taxa: document.querySelector('input[name=taxa]:checked').value, financiarItbi: $('financiarItbi').checked,
    valorImovel: valor('imovel'), entrada: valor('entrada'), prazoMeses: Number($('prazo').value),
  };
  const erro = validar(c1, c2, op);
  if (erro) return ($('msg-sim').textContent = erro);

  btn.disabled = true; carregando(true, 'Simulando no banco… pode levar até 1–2 min');
  try {
    const { claims } = await auth.currentUser.getIdTokenResult();
    const ref = await addDoc(collection(db, 'propostas'), {
      tipo: 'simulacao', status: 'pendente', resultado: null, erro: null, tentativas: 0,
      corretorUid: auth.currentUser.uid, imobiliariaId: claims.imobiliariaId,
      cliente: { ...c1, estadoCivil: $('estadoCivil').value, funcionarioItau: $('funcionario').checked, segundoComprador: c2 },
      operacao: op,
      criadoEm: serverTimestamp(),
    });
    // Tempo real: o robô atualiza o documento e o onSnapshot devolve o resultado na tela.
    unsubProposta = onSnapshot(ref, (snap) => {
      const p = snap.data();
      if (!p || ['pendente', 'processando'].includes(p.status)) return;
      btn.disabled = false;
      if (dispensado) { carregarHistorico(); unsubProposta?.(); return; } // o corretor seguiu navegando: o resultado aparece no Início
      renderResultado(p); mostrar('tela-resultado');
      carregando(false);
      unsubProposta?.();
    });
  } catch (err) {
    $('msg-sim').textContent = 'Erro ao enviar: ' + err.code;
    carregando(false);
  }
};

// ---------- Resultado (campos da simulação do portal) ----------
const brl = (v) => (v == null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const pct = (v) => (v == null ? '—' : v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '% a.a.');
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

function tabela(linhas) {
  const t = el('table', 'det');
  for (const [k, v] of linhas) { const tr = t.insertRow(); tr.insertCell().textContent = k; tr.insertCell().textContent = v; }
  return t;
}

function renderResultado(p) {
  const box = $('resultado'); box.replaceChildren();
  if (p.status === 'erro') {
    const c = el('section', 'card'); c.append(el('h2', 'sec', 'Não foi possível simular'), el('p', 'erro', p.erro?.mensagemUsuario ?? 'Tente novamente ou fale com o suporte.'));
    if (claimsAtuais.role === 'admin' && p.erro) { const d = el('pre', 'aviso', `[admin] codigo=${p.erro.codigo} etapa=${p.erro.etapa ?? '-'}\n${p.erro.detalhe ?? ''}`); d.style.whiteSpace = 'pre-wrap'; c.append(d); } // detalhe técnico só para o administrador
    const a = el('div', 'acoes'); const b = el('button', 'btn', 'Voltar e ajustar'); b.onclick = () => mostrar('tela-simulacao'); a.append(b); c.append(a); box.append(c); return;
  }
  const r = p.resultado; const op = p.operacao; const rendaTotal = (p.cliente.rendaBruta ?? 0) + (p.cliente.segundoComprador?.rendaBruta ?? 0);

  const c1 = el('section', 'card');
  const kp = el('div', 'kpis');
  for (const [k, v] of [['Prazo do financiamento', r.prazoMeses != null ? r.prazoMeses + ' meses' : '—'], ['Valor da primeira parcela', brl(r.primeiraParcela)], ['Valor da última parcela', brl(r.ultimaParcela)], ['Somatório das parcelas', brl(r.somatorioParcelas)]]) {
    const k1 = el('div', 'kpi'); k1.append(el('small', null, k), el('b', null, v)); kp.append(k1);
  }
  c1.append(kp);
  const acoes = el('div', 'acoes');
  const pdf = el('button', 'btn sec', 'Gerar PDF'); pdf.onclick = () => window.print();
  const nova = el('button', 'btn sec', 'Simular novamente'); nova.onclick = () => mostrar('tela-simulacao');
  const prop = el('button', 'btn', 'Preencher proposta'); prop.disabled = true; prop.title = 'Em breve';
  acoes.append(pdf, nova, prop); c1.append(acoes);

  const c2 = el('section', 'card'); c2.append(el('h2', 'sec', 'Detalhamento do cálculo'), tabela([
    ['Tipo do imóvel', op.tipoImovel], ['Renda total', brl(rendaTotal)], ['Valor do imóvel', brl(r.valorImovel ?? op.valorImovel)],
    ['Valor da entrada', brl(r.entrada ?? op.entrada)], ['Custos adicionais (cartório e tarifas)', op.financiarItbi ? 'Incorporado' : 'Não incorporado'],
    ['Valor total do financiamento', brl(r.valorFinanciado)], ['Sistema de amortização', r.sistema ?? op.sistema], ['Seguradora', op.seguradora],
    ['Custo efetivo do seguro habitacional (CESH)', pct(r.ceshAnual)], ['Linha de crédito', r.linhaCredito ?? '—'],
    ['Taxa de juros simulada', pct(r.taxaJurosAnual)], ['Correção monetária', 'Simulação sem TR'], ['IOF', brl(r.iof)], ['Custo Efetivo Total (CET)', pct(r.cetAnual)],
  ]));
  c2.append(el('p', 'aviso', 'Importante: isto é apenas uma simulação. A efetivação do resultado apresentado está condicionada à análise da proposta de financiamento. A taxa apresentada é apenas referência.'));

  const c3 = el('section', 'card'); c3.append(el('h2', 'sec', 'Demonstração do custo efetivo total (CET)'), tabela([
    ['1.1 Data da simulação', r.dataSimulacao ? new Date(r.dataSimulacao).toLocaleDateString('pt-BR') : '—'],
    ['1.2 Valor solicitado do financiamento', brl(r.valorFinanciado)], ['1.3 Valor do IOF', brl(r.iof)],
    ['1.4 Tarifa de administração do contrato (mensal)', brl(r.tarifaAdministracaoMensal)],
    ['1.5 Primeiro prêmio do seguro MIP (morte e invalidez permanente)', brl(r.seguroMip)],
    ['1.6 Primeiro prêmio do seguro DFI (danos físicos do imóvel)', brl(r.seguroDfi)],
    ['1.8 Taxa de juros pré-analisada', pct(r.taxaJurosAnual)], ['1.9 Prazo do contrato', r.prazoMeses != null ? r.prazoMeses + ' meses' : '—'],
    ['2.0 Custo efetivo total (CET)', pct(r.cetAnual)], ['a) Valor total devido', brl(r.valorTotalDevido)],
  ]));
  box.append(c1, c2, c3);
}

// ---------- Início: painel + lista (filtros no navegador) ----------
let docsHist = [];
async function carregarHistorico() {
  mostrar('tela-historico');
  const corpo = $('hist-corpo'); corpo.textContent = 'Carregando…';
  const admin = claimsAtuais.role === 'admin';
  const base = collection(db, 'propostas');
  // Sem orderBy junto do where (evita criar índice composto no Firestore); a ordenação é feita aqui.
  const q = admin ? query(base, orderBy('criadoEm', 'desc'), limit(300))
    : claimsAtuais.gestor ? query(base, where('imobiliariaId', '==', claimsAtuais.imobiliariaId), limit(300))
    : query(base, where('corretorUid', '==', auth.currentUser.uid), limit(200));
  $('hist-titulo').textContent = admin ? 'Todas as simulações e propostas' : claimsAtuais.gestor ? 'Simulações e propostas da imobiliária' : 'Suas simulações e propostas';
  try { docsHist = (await getDocs(q)).docs.map((d) => d.data()).sort((a, b) => (b.criadoEm?.toMillis?.() ?? 0) - (a.criadoEm?.toMillis?.() ?? 0)); }
  catch (err) { corpo.textContent = 'Não foi possível carregar (' + err.code + ').'; return; }
  renderHistorico();
}

function renderHistorico() {
  const ini = $('f-ini').value ? new Date($('f-ini').value + 'T00:00:00') : null;
  const fim = $('f-fim').value ? new Date($('f-fim').value + 'T23:59:59') : null;
  const cpf = soDigitos($('f-cpf').value); const nome = $('f-nome').value.trim().toLowerCase();
  const lista = docsHist.filter((p) => {
    const d = p.criadoEm?.toDate?.();
    return (!ini || (d && d >= ini)) && (!fim || (d && d <= fim)) && (!cpf || (p.cliente?.cpf ?? '').includes(cpf)) && (!nome || (p.cliente?.nome ?? '').toLowerCase().includes(nome));
  });
  const props = lista.filter((p) => p.tipo === 'proposta');
  $('k-sim').textContent = lista.filter((p) => p.tipo !== 'proposta').length; $('k-env').textContent = props.length;
  $('k-apr').textContent = props.filter((p) => p.status === 'aprovada').length; $('k-rec').textContent = props.filter((p) => p.status === 'recusada').length;
  const corpo = $('hist-corpo');
  if (!lista.length) return (corpo.textContent = 'Nenhum registro encontrado.');
  const t = el('table', 'hist'); const h = t.createTHead().insertRow();
  ['Data', 'Cliente', 'CPF', 'Tipo', 'Valor do imóvel', 'Valor financiado', '1ª parcela', 'Taxa a.a.', 'Situação'].forEach((x) => h.append(Object.assign(document.createElement('th'), { textContent: x })));
  const tb = t.createTBody();
  for (const p of lista) {
    const r = tb.insertRow();
    r.insertCell().textContent = p.criadoEm?.toDate().toLocaleString('pt-BR') ?? '—';
    r.insertCell().textContent = p.cliente?.nome ?? '—';
    r.insertCell().textContent = `***.***.***-${(p.cliente?.cpf ?? '').slice(-2)}`;
    r.insertCell().textContent = p.tipo === 'proposta' ? 'Proposta' : 'Simulação';
    r.insertCell().textContent = brl(p.operacao?.valorImovel);
    r.insertCell().textContent = brl(p.resultado?.valorFinanciado);
    r.insertCell().textContent = brl(p.resultado?.primeiraParcela);
    r.insertCell().textContent = p.resultado?.taxaJurosAnual != null ? pct(p.resultado.taxaJurosAnual).replace(' a.a.', '') : '—';
    r.insertCell().append(el('span', 'tag ' + p.status, p.status));
    const ehProp = p.tipo === 'proposta'; const abre = ['simulado', 'erro', 'enviada', 'preenchida'].includes(p.status);
    r.style.cursor = abre ? 'pointer' : 'default';
    if (abre) r.onclick = () => { if (ehProp) { window.__renderPropostaResultado(p); mostrar('tela-proposta-resultado'); } else { renderResultado(p); mostrar('tela-resultado'); } };
  }
  corpo.replaceChildren(t);
}
$('f-ok').onclick = renderHistorico;
$('f-limpar').onclick = () => { ['f-ini', 'f-fim', 'f-cpf', 'f-nome'].forEach((id) => { $(id).value = ''; }); renderHistorico(); };

$('form-sim').addEventListener('reset', () => setTimeout(atualizaTotal));

// ---------- Resultado da proposta ----------
window.__renderPropostaResultado = (p) => {
  const box = $('proposta-resultado'); box.replaceChildren();
  const c = el('section', 'card'); const acoes = el('div', 'acoes');
  const novo = el('button', 'btn', 'Nova proposta'); novo.onclick = () => { prop.limpar(); mostrar('tela-proposta'); };
  const ini = el('button', 'btn sec', 'Ir para o início'); ini.onclick = () => carregarHistorico(); acoes.append(ini, novo);
  if (p.status === 'enviada') {
    c.append(el('h2', 'sec', 'Proposta enviada ao banco'), el('p', null, 'Número da proposta:'), el('div', 'total', String(p.resultado?.numeroProposta ?? '—')),
      el('p', 'aviso', 'A análise de crédito começa agora. O resultado (aprovada, condicionada ou recusada) aparece no Início conforme o banco avança.'));
  } else if (p.status === 'preenchida') {
    c.append(el('h2', 'sec', 'Teste concluído: proposta preenchida, NÃO enviada'), el('p', null, 'O robô percorreu o formulário do banco e parou antes de confirmar (modo de teste).'));
  } else {
    c.append(el('h2', 'sec', 'A proposta não foi enviada'), el('p', 'erro', p.erro?.mensagemUsuario ?? 'Tente novamente ou fale com o suporte.'));
    if (claimsAtuais.role === 'admin' && p.erro) { const d = el('pre', 'aviso', `[admin] codigo=${p.erro.codigo} etapa=${p.erro.etapa ?? '-'}\n${p.erro.detalhe ?? ''}`); d.style.whiteSpace = 'pre-wrap'; c.append(d); }
  }
  c.append(acoes); box.append(c);
};
