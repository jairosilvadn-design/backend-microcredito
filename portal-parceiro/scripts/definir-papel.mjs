// Uso (rodar na SUA máquina, nunca no front): node scripts/definir-papel.mjs <uid> <admin|imobiliaria> [imobiliariaId] [gestor]
// Aprova um parceiro: grava custom claims no token do Firebase Auth. O usuário precisa relogar (ou getIdToken(true)).
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { applicationDefault } from 'firebase-admin/app';
import { readFileSync } from 'node:fs';

const [uid, role, imobiliariaId = uid, gestor] = process.argv.slice(2);
if (!uid || !['admin', 'imobiliaria'].includes(role)) { console.error('uso: definir-papel.mjs <uid> <admin|imobiliaria> [imobiliariaId] [gestor]'); process.exit(1); }
// Com GOOGLE_APPLICATION_CREDENTIALS apontando para um JSON usa a service account; sem ele (ex.: Google Cloud Shell) usa a sua própria conta Google.
const arq = process.env.GOOGLE_APPLICATION_CREDENTIALS;
initializeApp({
  credential: arq ? cert(JSON.parse(readFileSync(arq, 'utf8'))) : applicationDefault(),
  projectId: process.env.GCLOUD_PROJECT || 'portal-parceiro-credito',
});
await getAuth().setCustomUserClaims(uid, { role, aprovado: true, imobiliariaId, gestor: gestor === 'gestor' });
await getFirestore().doc(`parceiros/${uid}`).set({ status: 'aprovado', imobiliariaId }, { merge: true });
console.log('ok', { uid, role, imobiliariaId });
