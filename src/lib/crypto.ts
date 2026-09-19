import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../config/env';

/**
 * Criptografia de segredos em repouso com AES-256-GCM.
 *
 * Formato armazenado: "<kid>.<iv b64>.<tag b64>.<ciphertext b64>"
 *  - kid permite rotação de chave: novas gravações usam a chave ativa,
 *    leituras antigas continuam funcionando com a chave antiga.
 *  - AAD (dado associado) amarra o ciphertext à linha e ao tipo de token
 *    (ex.: "<merchantId>:access"). Copiar o token criptografado de um
 *    comerciante para outro faz a decriptação falhar.
 */

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12; // recomendado para GCM

const keyring = new Map<string, Buffer>();
for (const entry of env.TOKEN_ENC_KEYS.split(',')) {
  const [kid, b64] = entry.trim().split(':');
  if (!kid || !b64) throw new Error('TOKEN_ENC_KEYS mal formatado (use kid:base64)');
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error(`Chave ${kid} precisa ter 32 bytes`);
  keyring.set(kid, key);
}
if (!keyring.has(env.TOKEN_ENC_ACTIVE_KID)) {
  throw new Error('TOKEN_ENC_ACTIVE_KID não existe em TOKEN_ENC_KEYS');
}

export function encryptSecret(plaintext: string, aad: string): string {
  const kid = env.TOKEN_ENC_ACTIVE_KID;
  const key = keyring.get(kid)!;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [kid, iv.toString('base64'), tag.toString('base64'), ct.toString('base64')].join('.');
}

export function decryptSecret(payload: string, aad: string): string {
  const [kid, ivB64, tagB64, ctB64] = payload.split('.');
  if (!kid || !ivB64 || !tagB64 || !ctB64) throw new Error('Payload criptografado inválido');
  const key = keyring.get(kid);
  if (!key) throw new Error(`Chave ${kid} não encontrada no keyring`);
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, 'base64')),
    decipher.final(), // lança erro se conteúdo, tag ou AAD foram adulterados
  ]).toString('utf8');
}

export function isEncryptedWithActiveKey(payload: string): boolean {
  return payload.startsWith(`${env.TOKEN_ENC_ACTIVE_KID}.`);
}

export const tokenAad = (merchantId: string, kind: 'access' | 'refresh') => `${merchantId}:${kind}`;
