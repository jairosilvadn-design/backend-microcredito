// OPÇÃO 1 — Background Function (sufixo "-background"): responde 202 na hora e roda até 15 min.
// Limitações reais: Chromium via @sparticuz/chromium, ~1 GB de RAM, cold start de vários segundos, sem fila/concorrência
// controlada e sem IP fixo (o Itaú pode exigir IP liberado). Veja README: por isso a OPÇÃO 2 é a recomendada.
import chromium from '@sparticuz/chromium';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore, Timestamp } from 'firebase-admin/firestore';
import { executarSimulacao } from '../../robot/src/itau/executar.js';

if (!getApps().length) initializeApp({ credential: cert(JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64!, 'base64').toString())) });

export default async (req: Request) => {
  const { propostaId } = await req.json();
  const ref = getFirestore().doc(`propostas/${propostaId}`);
  const snap = await ref.get();
  const p = snap.data();
  if (!p || p.status !== 'pendente') return; // idempotência
  await ref.update({ status: 'processando', travadoEm: Timestamp.now() });
  try {
    const resultado = await executarSimulacao(
      { cliente: p.cliente, operacao: p.operacao },
      { executablePath: await chromium.executablePath(), args: chromium.args },
    );
    await ref.update({ status: resultado.status.toLowerCase(), resultado, concluidoEm: Timestamp.now() });
  } catch (e: any) {
    await ref.update({ status: 'erro', erro: { codigo: e.codigo ?? 'DESCONHECIDO', etapa: e.etapa ?? null, mensagemUsuario: 'Tente novamente.' } });
  }
};
