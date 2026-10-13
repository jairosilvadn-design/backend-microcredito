// Roda no build: grava public/config.js com a configuração PÚBLICA do login do Firebase (web), lida das variáveis de ambiente.
// Estes valores não são segredos (qualquer site com login Firebase os expõe), mas ficam em variável para você poder corrigir sem mexer no código.
import { writeFileSync } from 'node:fs';

const e = process.env;
const projectId = e.FIREBASE_PROJECT_ID || '';
const cfg = {
  apiKey: e.FIREBASE_WEB_API_KEY || '',
  authDomain: e.FIREBASE_AUTH_DOMAIN || (projectId ? `${projectId}.firebaseapp.com` : ''),
  projectId,
  appId: e.FIREBASE_APP_ID || '',
  messagingSenderId: e.FIREBASE_SENDER_ID || '',
};
writeFileSync('public/config.js', `window.__FB = ${JSON.stringify(cfg)};\n`);
console.log(`public/config.js gerado (projeto: ${projectId || 'não definido'}, apiKey ${cfg.apiKey ? 'definida' : 'AUSENTE'})`);
