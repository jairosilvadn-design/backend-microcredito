import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import { getFirestore, doc, setDoc, addDoc, collection, onSnapshot, serverTimestamp }
  from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const $ = (id) => document.getElementById(id);
const telas = ['tela-login', 'tela-pendente', 'tela-simulacao', 'tela-resultado'];
const mostrar = (t) => telas.forEach((x) => $(x).classList.toggle('hidden', x !== t));
const soDigitos = (s) => s.replace(/\D/g, '');
// Máscara de dinheiro: digita só números e o campo vira "R$ 1.234,56" (os dois últimos dígitos são os centavos).
const fmtBRL = (centavos) => (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const valor = (id) => Number(soDigitos($(id).value || '0')) / 100; // número em reais
document.querySelectorAll('[data-moeda]').forEach((el) => {
  el.addEventListener('input', () => { const d = soDigitos(el.value); el.value = d ? fmtBRL(Number(d)) : ''; });
});
$('cpf').addEventListener('input', () => {
  const d = soDigitos($('cpf').value).slice(0, 11);
  $('cpf').value = d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})(\d{1,2})$/, '$1-$2');
});
let cadastro = false;
let unsubProposta = null;

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

// Papel e aprovação vêm das custom claims do token (definidas só pelo admin via scripts/definir-papel.mjs).
onAuthStateChanged(auth, async (user) => {
  if (unsubProposta) { unsubProposta(); unsubProposta = null; }
  if (!user) return mostrar('tela-login');
  const { claims } = await user.getIdTokenResult(true);
  mostrar(claims.aprovado ? 'tela-simulacao' : 'tela-pendente');
});

$('fgts').onchange = () => $('fgts-valor-l').classList.toggle('hidden', $('fgts').value !== 'sim');

$('form-sim').onsubmit = async (e) => {
  e.preventDefault();
  const btn = $('enviar'); $('msg-sim').textContent = '';
  const cpf = soDigitos($('cpf').value);
  if (cpf.length !== 11) return ($('msg-sim').textContent = 'CPF inválido.');
  if (valor('renda') <= 0 || valor('imovel') <= 0 || valor('financ') <= 0) return ($('msg-sim').textContent = 'Preencha renda, valor do imóvel e valor do financiamento.');
  if (valor('financ') > valor('imovel')) return ($('msg-sim').textContent = 'O financiamento não pode ser maior que o valor do imóvel.');
  btn.disabled = true; btn.textContent = 'Analisando no banco… (pode levar até 1–2 min)';
  try {
    const { claims } = await auth.currentUser.getIdTokenResult();
    const ref = await addDoc(collection(db, 'propostas'), {
      status: 'pendente', resultado: null, erro: null, tentativas: 0,
      corretorUid: auth.currentUser.uid, imobiliariaId: claims.imobiliariaId,
      cliente: { cpf, nascimento: $('nasc').value, rendaBruta: valor('renda'),
                 fgts: $('fgts').value === 'sim', fgtsValor: $('fgts').value === 'sim' ? valor('fgtsValor') : 0 },
      operacao: { valorImovel: valor('imovel'), valorFinanciamento: valor('financ'), sistema: $('sistema').value },
      criadoEm: serverTimestamp(),
    });
    // Tempo real: o robô atualiza o documento e o onSnapshot devolve o resultado na tela.
    unsubProposta = onSnapshot(ref, (snap) => {
      const p = snap.data();
      if (!p || ['pendente', 'processando'].includes(p.status)) return;
      renderResultado(p); mostrar('tela-resultado');
      btn.disabled = false; btn.textContent = 'Enviar para Análise de Crédito';
      unsubProposta?.();
    });
  } catch (err) {
    $('msg-sim').textContent = 'Erro ao enviar: ' + err.code;
    btn.disabled = false; btn.textContent = 'Enviar para Análise de Crédito';
  }
};

const brl = (v) => (v == null ? '—' : v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
function renderResultado(p) {
  const el = $('resultado'); el.replaceChildren();
  const linha = (t) => { const d = document.createElement('p'); d.textContent = t; el.append(d); };
  if (p.status === 'erro') return linha('Não foi possível concluir a análise automática. Nossa equipe foi avisada. ' + (p.erro?.mensagemUsuario ?? ''));
  const r = p.resultado;
  const b = document.createElement('span'); b.className = 'badge ' + r.status; b.textContent = r.status.replace('_', ' ');
  el.append(b);
  linha('Valor aprovado: ' + brl(r.valorAprovado));
  linha('Taxa de juros: ' + (r.taxaJurosAnual != null ? r.taxaJurosAnual.toFixed(2) + '% a.a.' : '—'));
  linha('Nº da proposta/carta: ' + (r.numeroProposta ?? '—'));
  if (r.motivo) linha('Motivo: ' + r.motivo);
}
$('nova').onclick = () => { $('form-sim').reset(); mostrar('tela-simulacao'); };
