import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env';

/**
 * Valida o header x-signature do Mercado Pago.
 *   x-signature: ts=1704908010,v1=<hmac-sha256 hex>
 * Manifest: "id:<data.id>;request-id:<x-request-id>;ts:<ts>;"
 * Partes ausentes são omitidas do manifest. data.id alfanumérico vai em minúsculas.
 */
export function verifyMpSignature(params: {
  xSignature?: string;
  xRequestId?: string;
  dataId?: string;
}): { valid: boolean; ts?: string } {
  const { xSignature, xRequestId } = params;
  if (!xSignature) return { valid: false };

  let ts: string | undefined;
  let v1: string | undefined;
  for (const part of xSignature.split(',')) {
    const [k, v] = part.split('=').map((s) => s.trim());
    if (k === 'ts') ts = v;
    if (k === 'v1') v1 = v;
  }
  if (!ts || !v1) return { valid: false };

  const dataId = params.dataId && /^[a-z0-9]+$/i.test(params.dataId) ? params.dataId.toLowerCase() : params.dataId;

  let manifest = '';
  if (dataId) manifest += `id:${dataId};`;
  if (xRequestId) manifest += `request-id:${xRequestId};`;
  manifest += `ts:${ts};`;

  const expected = createHmac('sha256', env.MP_WEBHOOK_SECRET).update(manifest).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(v1, 'hex');
  return { valid: a.length === b.length && timingSafeEqual(a, b), ts };
}
