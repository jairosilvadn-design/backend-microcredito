// OPÇÃO 1 — Função síncrona (limite ~10 s, configurável até 26 s): só valida o token e dispara a background function.
// O front chama esta função com o ID token em vez de gravar direto no Firestore (a proposta nasce aqui, validada no servidor).
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { z } from 'zod';

if (!getApps().length) initializeApp({ credential: cert(JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64!, 'base64').toString())) });

const Body = z.object({
  cliente: z.object({ cpf: z.string().regex(/^\d{11}$/), nascimento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), rendaBruta: z.number().positive(), fgts: z.boolean(), fgtsValor: z.number().min(0) }),
  operacao: z.object({ valorImovel: z.number().positive(), valorFinanciamento: z.number().positive(), sistema: z.enum(['SAC', 'PRICE']) }),
});

export default async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  const token = req.headers.get('authorization')?.replace(/^Bearer /, '');
  if (!token) return new Response('Unauthorized', { status: 401 });
  const user = await getAuth().verifyIdToken(token).catch(() => null);
  if (!user?.aprovado) return new Response('Forbidden', { status: 403 });

  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ erro: 'dados_invalidos' }, { status: 400 });

  const ref = await getFirestore().collection('propostas').add({
    ...parsed.data, status: 'pendente', resultado: null, erro: null, tentativas: 0,
    corretorUid: user.uid, imobiliariaId: user.imobiliariaId, criadoEm: FieldValue.serverTimestamp(),
  });
  // Dispara a background function sem esperar.
  const base = new URL(req.url).origin;
  await fetch(`${base}/.netlify/functions/processar-proposta-background`, { method: 'POST', body: JSON.stringify({ propostaId: ref.id }) });
  return Response.json({ propostaId: ref.id }, { status: 202 });
};
