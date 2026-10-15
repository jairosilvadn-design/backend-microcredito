import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, doc, setDoc, addDoc, collection, onSnapshot, serverTimestamp }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';
import { opcoes, PRAZO_MIN, PRAZO_MAX } from './opcoes.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const $ = (id) => document.getElementById(id);
const telas = ['tela-login', 'tela-pendente', 'tela-simulacao', 'tela-resultado'];
const mostrar = (t) => telas.forEach((x) => $(x).classList.toggle('hidden', x !== t));
const soDigitos = (s) => (s ?? '').replace(/\D/g, '');
let cadastro = false;
let unsubProposta = null;

// ---------- Listas de seleção ----------
for (const [id, lista] of Object.entries({ segmento: opcoes.segmento, estadoCivil: opcoes.estadoCivil, tipoImovel: opcoes.tipoImovel, seguradora: opcoes.seguradora, sistema: opcoes.sistema })) {
  const sel = $(id);
  sel.append(new Option('Selecione', ''));
  lista.forEach((t) => sel.append(new Option(t, t)));
}
$('prazo').min = PRAZO_MIN; $('prazo').max = PRAZO_MAX;

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

for (const id of ['sair1', 'sair2']) $(id).onclick = (e) => { e.preventDefault(); signOut(auth); };

// Papel e aprovação vêm das custom claims do token (definidas só pelo admin).
onAuthStateChanged(auth, async (user) => {
  if (unsubProposta) { unsubProposta(); unsubProposta = null; }
  if (!user) return mostrar('tela-login');
  const { claims } = await user.getIdTokenResult(true);
  mostrar(claims.aprovado ? 'tela-simulacao' : 'tela-pendente');
});

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

function validar(c1, c2, op) {
  if (!cpfValido(c1.cpf)) return 'CPF do comprador principal inválido.';
  if (c2 && !cpfValido(c2.cpf)) return 'CPF do 2º comprador inválido.';
  if (!maiorDeIdade(c1.nascimento) || (c2 && !maiorDeIdade(c2.nascimento))) return 'O comprador deve ter 18 anos ou mais.';
  if (c1.rendaBruta <= 0 || (c2 && c2.rendaBruta <= 0)) return 'Informe a renda bruta mensal.';
  if (op.valorImovel <= 0) return 'Informe o valor do imóvel.';
  if (op.entrada >= op.valorImovel) return 'A entrada deve ser menor que o valor do imóvel.';
  if (!(op.prazoMeses >= PRAZO_MIN && op.prazoMeses <= PRAZO_MAX)) return `O prazo deve ficar entre ${PRAZO_MIN} e ${PRAZO_MAX} meses.`;
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

  btn.disabled = true; btn.textContent = 'Simulando no banco… (pode levar até 1–2 min)';
  try {
    const { claims } = await auth.currentUser.getIdTokenResult();
    const ref = await addDoc(collection(db, 'propostas'), {
      status: 'pendente', resultado: null, erro: null, tentativas: 0,
      corretorUid: auth.currentUser.uid, imobiliariaId: claims.imobiliariaId,
      cliente: { ...c1, segmento: $('segmento').value, estadoCivil: $('estadoCivil').value, funcionarioItau: $('funcionario').checked, segundoComprador: c2 },
      operacao: op,
      criadoEm: serverTimestamp(),
    });
    // Tempo real: o robô atualiza o documento e o onSnapshot devolve o resultado na tela.
    unsubProposta = onSnapshot(ref, (snap) => {
      const p = snap.data();
      if (!p || ['pendente', 'processando'].includes(p.status)) return;
      renderResultado(p); mostrar('tela-resultado');
      btn.disabled = false; btn.textContent = 'Simular';
      unsubProposta?.();
    });
  } catch (err) {
    $('msg-sim').textContent = 'Erro ao enviar: ' + err.code;
    btn.disabled = false; btn.textContent = 'Simular';
  }
};

// ---------- Resultado (campos da simulação do portal) ----------
const brl = (v) => (v == null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const pct = (v) => (v == null ? '—' : v.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) + '%');
function renderResultado(p) {
  const el = $('resultado'); el.replaceChildren();
  const par = (t, cls) => { const d = document.createElement('p'); if (cls) d.className = cls; d.textContent = t; el.append(d); };
  if (p.status === 'erro') return par('Não foi possível concluir a simulação automática. Tente novamente ou fale com o suporte. ' + (p.erro?.mensagemUsuario ?? ''));
  const r = p.resultado;
  const b = document.createElement('span'); b.className = 'badge'; b.textContent = 'Simulação concluída'; el.append(b);
  const linhas = [
    ['Prazo do financiamento', r.prazoMeses != null ? r.prazoMeses + ' meses' : '—'],
    ['Valor da primeira parcela', brl(r.primeiraParcela)],
    ['Valor da última parcela', brl(r.ultimaParcela)],
    ['Somatório das parcelas', brl(r.somatorioParcelas)],
    ['Valor total do financiamento', brl(r.valorTotalFinanciado)],
    ['Sistema de amortização', r.sistema ?? '—'],
    ['Seguradora', r.seguradora ?? '—'],
    ['Linha de crédito', r.linhaCredito ?? '—'],
    ['Taxa de juros simulada', r.taxaJuros ?? '—'],
    ['Custo Efetivo Total (CET)', r.cet ?? '—'],
  ];
  const t = document.createElement('table');
  for (const [k, v] of linhas) { const tr = t.insertRow(); tr.insertCell().textContent = k; tr.insertCell().textContent = v; }
  el.append(t);
  par('Isto é apenas uma simulação. A efetivação está condicionada à análise da proposta de financiamento. A taxa apresentada é apenas para referência.', 'aviso');
}
$('nova').onclick = () => { $('form-sim').reset(); $('bloco-c2').classList.add('hidden'); mostrar('tela-simulacao'); };
