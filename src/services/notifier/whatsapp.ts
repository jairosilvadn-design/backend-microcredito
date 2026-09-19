import type { Merchant } from '@prisma/client';
import { env } from '../../config/env';

export const whatsappEnabled = () =>
  Boolean(env.WHATSAPP_TOKEN && env.WHATSAPP_PHONE_NUMBER_ID && env.WHATSAPP_TEMPLATE_COBRANCA);

/**
 * Envia a cobrança por template aprovado na WhatsApp Cloud API (Meta).
 * Mensagens iniciadas pela empresa fora da janela de 24h EXIGEM template aprovado.
 *
 * Template esperado (categoria "Utilidade"), 3 variáveis no corpo:
 *   Olá, {{1}}! A parcela de hoje do seu contrato ficou em aberto: {{2}}.
 *   Para pagar via Pix, acesse: {{3}}
 */
export async function sendChargeTemplate(
  merchant: Merchant,
  amountLabel: string,
  paymentUrl: string,
): Promise<{ sent: boolean; error?: string }> {
  if (!whatsappEnabled()) return { sent: false, error: 'whatsapp_not_configured' };

  const url = `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: merchant.whatsapp.replace(/\D/g, ''),
        type: 'template',
        template: {
          name: env.WHATSAPP_TEMPLATE_COBRANCA,
          language: { code: env.WHATSAPP_TEMPLATE_LANG },
          components: [{
            type: 'body',
            parameters: [
              { type: 'text', text: merchant.ownerName.split(' ')[0] ?? merchant.ownerName },
              { type: 'text', text: amountLabel },
              { type: 'text', text: paymentUrl },
            ],
          }],
        },
      }),
    });
    if (!res.ok) return { sent: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}` };
    return { sent: true };
  } catch (err) {
    return { sent: false, error: String(err) };
  }
}
