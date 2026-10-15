// Uso (rodar na SUA máquina, nunca no front): node scripts/definir-papel.mjs <uid> <admin|imobiliaria> [imobiliariaId] [gestor]
// Aprova um parceiro: grava custom claims no token do Firebase Auth. O usuário precisa relogar (ou getIdToken(true)).
import { initializeApp, cert } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { readFileSync } from 'node:fs';

const [uid, role, imobiliariaId = uid, gestor] = process.argv.slice(2);
if (!uid || !['admin', 'imobiliaria'].includes(role)) { console.error('uso: definir-papel.mjs <uid> <admin|imobiliaria> [imobiliariaId] [gestor]'); process.exit(1); }
initializeApp({ credential: cert(JSON.parse(readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS, 'utf8'))) });
await getAuth().setCustomUserClaims(uid, { role, aprovado: true, imobiliariaId, gestor: gestor === 'gestor' });
await getFirestore().doc(`parceiros/${uid}`).set({ status: 'aprovado', imobiliariaId }, { merge: true });
console.log('ok', { uid, role, imobiliariaId });
