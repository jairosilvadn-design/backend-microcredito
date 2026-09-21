import { createHash, randomBytes } from 'node:crypto';

/** PKCE (RFC 7636), método S256. */
export function generatePkcePair() {
  const verifier = randomBytes(32).toString('base64url'); // 43 chars (faixa válida: 43..128)
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge, method: 'S256' as const };
}

/** state opaco e imprevisível (anti-CSRF). */
export function generateState(): string {
  return randomBytes(32).toString('base64url');
}
