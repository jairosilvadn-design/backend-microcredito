import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp, type DocumentReference } from 'firebase-admin/firestore';
import pLimit from 'p-limit';
import { config } from './config.js';
import { RoboError } from './itau/erros.js';
import { executarProposta, executarSimulacao } from './itau/executar.js';
import { log } from './logger.js';
import type { DadosProposta, DadosSimulacao } from './types.js';

// Aceita a chave do Firebase colada como JSON puro (mais simples) ou em base64.
const chaveBruta = config.FIREBASE_SERVICE_ACCOUNT_B64.trim();
initializeApp({ credential: cert(JSON.parse(chaveBruta.startsWith('{') ? chaveBruta : Buffer.from(chaveBruta, 'base64').toString('utf8'))) });
const db = getFirestore();
const limite = pLimit(config.ROBO_CONCURRENCY); // fila em memória: no máx. N navegadores ao mesmo tempo
const WORKER_ID = `${process.env.HOSTNAME ?? 'local'}-${process.pid}`;

type Job = { tipo: 'simulacao'; dados: DadosSimulacao } | { tipo: 'proposta'; dados: DadosProposta; scr: boolean };

/** Reivindica a proposta/simulação de forma atômica (pendente -> processando). Dois workers nunca pegam a mesma. */
async function reivindicar(ref: DocumentReference): Promise<Job | null> {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const p = snap.data();
    if (!p || p.status !== 'pendente') return null;
    tx.update(ref, { status: 'processando', worker: WORKER_ID, travadoEm: Timestamp.now(), tentativas: FieldValue.increment(1) });
    tx.set(ref.collection('historico').doc(), { status: 'processando', em: Timestamp.now(), worker: WORKER_ID });
    if (p.tipo === 'proposta') return { tipo: 'proposta', dados: p.proposta as DadosProposta, scr: p.consentimentoScr?.aceito === true && !!p.consentimentoScr?.uid } as Job;
    return { tipo: 'simulacao', dados: { cliente: p.cliente, operacao: p.operacao } as DadosSimulacao } as Job;
  });
}

async function processar(ref: DocumentReference) {
  const job = await reivindicar(ref);
  if (!job) return;
  const t0 = Date.now();
  try {
    if (job.tipo === 'proposta') {
      const r = await executarProposta(job.dados, job.scr);
      const status = r.status === 'ENVIADA' ? 'enviada' : 'preenchida'; // 'preenchida' = modo de teste (nada foi enviado ao banco)
      await ref.update({ status, resultado: r, erro: null, concluidoEm: Timestamp.now(), proposta: FieldValue.delete() }); // não guarda os dados pessoais além do necessário
      await ref.collection('historico').add({ status, em: Timestamp.now(), ms: Date.now() - t0 });
      log.info({ id: ref.id, status, ms: Date.now() - t0 }, 'proposta processada');
      return;
    }
    const resultado = await executarSimulacao(job.dados);
    await ref.update({ status: 'simulado', resultado, erro: null, concluidoEm: Timestamp.now() });
    await ref.collection('historico').add({ status: 'simulado', em: Timestamp.now(), ms: Date.now() - t0 });
    log.info({ id: ref.id, status: resultado.status, ms: Date.now() - t0 }, 'simulação concluída');
  } catch (e) {
    const err = e instanceof RoboError ? e : new RoboError('PORTAL_INDISPONIVEL', e instanceof Error ? e.message : 'erro desconhecido', true);
    const tentativas = ((await ref.get()).data()?.tentativas as number) ?? 1;
    // Proposta NUNCA volta para a fila sozinha: repetir poderia criar proposta duplicada no banco.
    const repetir = job.tipo === 'simulacao' && err.retentavel && tentativas < config.ROBO_MAX_TENTATIVAS;
    log.warn({ id: ref.id, tipo: job.tipo, codigo: err.codigo, etapa: err.etapa, tentativas, repetir }, 'falha no robô');
    const msgUsuario = err.codigo === 'DADOS_INVALIDOS' ? err.message.replace(/^Portal recusou (os dados|a proposta): /, '')
      : err.codigo === 'ENVIO_INCERTO' ? err.message
      : err.codigo === 'ACAO_HUMANA' ? 'O envio está bloqueado por uma pendência na conta do correspondente. Avise o administrador.'
      : 'Tente novamente em instantes ou fale com o suporte.';
    await ref.update(repetir
      ? { status: 'pendente', worker: null }
      : { status: 'erro', erro: { codigo: err.codigo, etapa: err.etapa ?? null, mensagemUsuario: msgUsuario }, concluidoEm: Timestamp.now(), ...(job.tipo === 'proposta' ? { proposta: FieldValue.delete() } : {}) });
    await ref.collection('historico').add({ status: repetir ? 'pendente' : 'erro', codigo: err.codigo, em: Timestamp.now() });
  }
}

export function iniciarWorker() {
  // Escuta propostas pendentes (mais antigas primeiro). Cada novo doc dispara processar().
  // Só igualdade em um campo (não exige índice composto no Firestore).
  db.collection('propostas').where('status', '==', 'pendente').limit(50).onSnapshot(
    (qs) => qs.docChanges().filter((c) => c.type !== 'removed').forEach((c) => { void limite(() => processar(c.doc.ref)); }),
    (e) => { log.error(`listener caiu: ${e.message}`); process.exit(1); }, // o orquestrador reinicia o container
  );

  // "Reaper": propostas presas em 'processando' (worker morreu) voltam para a fila.
  setInterval(async () => { try {
    const corte = Timestamp.fromMillis(Date.now() - config.ROBO_LOCK_TTL_MS);
    const todas = await db.collection('propostas').where('status', '==', 'processando').get(); // filtro de tempo em código: evita índice composto
    const presas = { docs: todas.docs.filter((d) => ((d.data().travadoEm as Timestamp | undefined)?.toMillis() ?? 0) < corte.toMillis()) };
    for (const d of presas.docs) {
      const esgotou = d.data().tipo === 'proposta' || (d.data().tentativas ?? 0) >= config.ROBO_MAX_TENTATIVAS;
      await d.ref.update(esgotou ? { status: 'erro', erro: { codigo: d.data().tipo === 'proposta' ? 'ENVIO_INCERTO' : 'TIMEOUT', etapa: 'worker', mensagemUsuario: d.data().tipo === 'proposta' ? 'O robô parou durante o envio: confira no portal do Itaú se a proposta foi criada antes de reenviar.' : 'Tente novamente.' } } : { status: 'pendente', worker: null });
    }
  } catch (e) { log.warn(`varredura de propostas presas falhou: ${(e as Error).message}`); } }, 60_000).unref();

  log.info({ concorrencia: config.ROBO_CONCURRENCY }, 'robô ouvindo a fila');
}
