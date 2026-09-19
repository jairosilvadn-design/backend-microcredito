import type { Merchant } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { dayBoundsSaoPaulo, toMpDate } from '../../lib/dates';
import { mpRequest } from '../mercadopago/http';
import { getMerchantAccessToken } from '../mercadopago/oauth.service';
import type { MpPayment } from '../mercadopago/types';
import { upsertMpPayment } from '../payment-sync.service';

interface SearchResponse {
  paging: { total: number; limit: number; offset: number };
  results: MpPayment[];
}

const PAGE_SIZE = 50;
// Teto conservador de resultados por janela. Acima disso a janela é dividida
// ao meio (paginação muito profunda por offset fica lenta e instável).
export const MAX_RESULTS_PER_WINDOW = 1000;
const MIN_WINDOW_MS = 60_000;

/**
 * Busca TODOS os pagamentos atualizados entre begin e end.
 * Usa range=date_last_updated para também capturar estornos e chargebacks
 * de vendas antigas (a venda muda de approved para refunded).
 */
export async function fetchPaymentsUpdatedBetween(
  token: string,
  begin: Date,
  end: Date,
  depth = 0,
): Promise<MpPayment[]> {
  const collected: MpPayment[] = [];
  let offset = 0;

  for (;;) {
    const qs = new URLSearchParams({
      sort: 'date_last_updated',
      criteria: 'asc',
      range: 'date_last_updated',
      begin_date: toMpDate(begin),
      end_date: toMpDate(end),
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    const page = await mpRequest<SearchResponse>(`/v1/payments/search?${qs.toString()}`, { token });

    const total = page.paging?.total ?? 0;
    const canSplit = end.getTime() - begin.getTime() > MIN_WINDOW_MS && depth < 10;
    if (offset === 0 && total > MAX_RESULTS_PER_WINDOW && canSplit) {
      const mid = new Date(Math.floor((begin.getTime() + end.getTime()) / 2));
      const left = await fetchPaymentsUpdatedBetween(token, begin, mid, depth + 1);
      const right = await fetchPaymentsUpdatedBetween(token, new Date(mid.getTime() + 1), end, depth + 1);
      return dedupeById([...left, ...right]);
    }

    const results = page.results ?? [];
    collected.push(...results);
    offset += results.length;

    if (results.length === 0 || offset >= total) break;
    if (offset >= MAX_RESULTS_PER_WINDOW) {
      throw new Error(`Janela com mais de ${MAX_RESULTS_PER_WINDOW} pagamentos em menos de 1 minuto`);
    }
  }
  return dedupeById(collected);
}

function dedupeById(list: MpPayment[]): MpPayment[] {
  const map = new Map<number, MpPayment>();
  for (const p of list) map.set(p.id, p);
  return [...map.values()];
}

export interface SyncResult {
  ok: boolean;
  fetched: number;
  error?: string;
}

/**
 * Sincroniza o extrato do comerciante desde o início de fromYmd até AGORA.
 * Ir até agora (e não só até o fim do dia auditado) garante que uma venda
 * de ontem estornada hoje cedo já apareça como estornada.
 */
export async function syncMerchantStatement(merchant: Merchant, fromYmd: string): Promise<SyncResult> {
  if (merchant.status !== 'ACTIVE' && merchant.status !== 'SUSPENDED') {
    return { ok: false, fetched: 0, error: `status ${merchant.status}` };
  }

  try {
    const token = await getMerchantAccessToken(merchant.id);
    const payments = await fetchPaymentsUpdatedBetween(token, dayBoundsSaoPaulo(fromYmd).start, new Date());

    // Quais desses pagamentos foram gerados pela nossa plataforma (com split)?
    const ids = payments.map((p) => BigInt(p.id));
    const refs = payments.map((p) => p.external_reference).filter((r): r is string => Boolean(r));
    const ours = await prisma.charge.findMany({
      where: {
        merchantId: merchant.id,
        type: { in: ['PIX_BALCAO', 'PAYMENT_LINK'] },
        OR: [{ mpPaymentId: { in: ids } }, { externalRef: { in: refs } }],
      },
      select: { mpPaymentId: true, externalRef: true },
    });
    const ourIds = new Set(ours.map((c) => c.mpPaymentId?.toString()).filter(Boolean));
    const ourRefs = new Set(ours.map((c) => c.externalRef));

    for (const p of payments) {
      const viaSplit = ourIds.has(String(p.id)) || (p.external_reference ? ourRefs.has(p.external_reference) : false);
      await upsertMpPayment(merchant.id, p, viaSplit, merchant.mpUserId);
    }
    return { ok: true, fetched: payments.length };
  } catch (err) {
    return { ok: false, fetched: 0, error: String(err).slice(0, 500) };
  }
}
