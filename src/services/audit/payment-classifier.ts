import type { MpPayment } from '../mercadopago/types';

/**
 * Quais movimentações do extrato contam como VENDA do comerciante.
 *
 *  - regular_payment: Pix/QR, link, checkout, maquininha em alguns fluxos
 *  - pos_payment: vendas presenciais na Point
 *
 * Ficam de fora: money_transfer (transferências recebidas), account_fund,
 * recurring_payment, estornos e qualquer status diferente de approved.
 *
 * CALIBRAGEM: antes de ir para produção, use GET /api/merchants/:id/statement
 * num dia com vendas reais na maquininha e confirme os operation_type que aparecem.
 */
export const SALE_OPERATION_TYPES = new Set(['regular_payment', 'pos_payment']);

export function isSale(p: MpPayment, merchantMpUserId?: bigint | null): boolean {
  if (p.status !== 'approved') return false;
  if (!SALE_OPERATION_TYPES.has(p.operation_type ?? '')) return false;
  // O extrato pode trazer pagamentos em que o comerciante foi o PAGADOR (compras dele).
  if (merchantMpUserId != null && p.collector_id != null && BigInt(p.collector_id) !== merchantMpUserId) {
    return false;
  }
  return true;
}
