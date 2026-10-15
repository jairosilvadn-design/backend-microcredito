import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp, type DocumentReference } from 'firebase-admin/firestore';
import pLimit from 'p-limit';
import { config } from './config.js';
import { RoboError } from './itau/erros.js';
import { executarSimulacao } from './itau/executar.js';
import { log } from './logger.js';
import type { DadosSimulacao } from './types.js';

initializeApp({ credential: cert(JSON.parse(Buffer.from(config.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8'))) });
const db = getFirestore();
const limite = pLimit(config.ROBO_CONCURRENCY); // fila em memória: no máx. N navegadores ao mesmo tempo
const WORKER_ID = `${process.env.HOSTNAME ?? 'local'}-${process.pid}`;

/** Reivindica a proposta de forma atômica (pendente -> processando). Dois workers nunca pegam a mesma. */
async function reivindicar(ref: DocumentReference): Promise<DadosSimulacao | null> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const p = snap.data();
    if (!p || p.status !== 'pendente') return null;
    tx.update(ref, { status: 'processando', worker: WORKER_ID, travadoEm: Timestamp.now(), tentativas: FieldValue.increment(1) });
    tx.set(ref.collection('historico').doc(), { status: 'processando', em: Timestamp.now(), worker: WORKER_ID });
    return { cliente: p.cliente, operacao: p.operacao } as DadosSimulacao;
  });
}

async function processar(ref: DocumentReference) {
  const dados = await reivindicar(ref);
  if (!dados) return;
  const t0 = Date.now();
  try {
    const resultado = await executarSimulacao(dados);
    await ref.update({ status: 'simulado', resultado, erro: null, concluidoEm: Timestamp.now() });
    await ref.collection('historico').add({ status: 'simulado', em: Timestamp.now(), ms: Date.now() - t0 });
    log.info({ id: ref.id, status: resultado.status, ms: Date.now() - t0 }, 'proposta concluída');
  } catch (e) {
    const err = e instanceof RoboError ? e : new RoboError('PORTAL_INDISPONIVEL', e instanceof Error ? e.message : 'erro desconhecido', true);
    const tentativas = ((await ref.get()).data()?.tentativas as number) ?? 1;
    const repetir = err.retentavel && tentativas < config.ROBO_MAX_TENTATIVAS;
    log.warn({ id: ref.id, codigo: err.codigo, etapa: err.etapa, tentativas, repetir }, 'falha no robô');
    await ref.update(repetir
      ? { status: 'pendente', worker: null }
      : { status: 'erro', erro: { codigo: err.codigo, etapa: err.etapa ?? null, mensagemUsuario: 'Tente novamente em instantes ou fale com o suporte.' }, concluidoEm: Timestamp.now() });
    await ref.collection('historico').add({ status: repetir ? 'pendente' : 'erro', codigo: err.codigo, em: Timestamp.now() });
  }
}

export function iniciarWorker() {
  // Escuta propostas pendentes (mais antigas primeiro). Cada novo doc dispara processar().
  db.collection('propostas').where('status', '==', 'pendente').orderBy('criadoEm').limit(50).onSnapshot(
    (qs) => qs.docChanges().filter((c) => c.type !== 'removed').forEach((c) => { void limite(() => processar(c.doc.ref)); }),
    (e) => { log.error({ err: e.message }, 'listener caiu'); process.exit(1); }, // o orquestrador reinicia o container
  );

  // "Reaper": propostas presas em 'processando' (worker morreu) voltam para a fila.
  setInterval(async () => {
    const corte = Timestamp.fromMillis(Date.now() - config.ROBO_LOCK_TTL_MS);
    const presas = await db.collection('propostas').where('status', '==', 'processando').where('travadoEm', '<', corte).get();
    for (const d of presas.docs) {
      const esgotou = (d.data().tentativas ?? 0) >= config.ROBO_MAX_TENTATIVAS;
      await d.ref.update(esgotou ? { status: 'erro', erro: { codigo: 'TIMEOUT', etapa: 'worker', mensagemUsuario: 'Tente novamente.' } } : { status: 'pendente', worker: null });
    }
  }, 60_000).unref();

  log.info({ concorrencia: config.ROBO_CONCURRENCY }, 'robô ouvindo a fila');
}
