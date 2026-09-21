const MP_API = 'https://api.mercadopago.com';

export class MercadoPagoError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'MercadoPagoError';
  }

  /** refresh_token/código inválido, expirado ou acesso revogado pelo comerciante. */
  get isInvalidGrant(): boolean {
    const b = this.body as { error?: string; message?: string } | null;
    return this.status === 400 && (b?.error === 'invalid_grant' || /invalid_grant/i.test(b?.message ?? ''));
  }
}

interface MpRequestOptions {
  method?: 'GET' | 'POST' | 'PUT';
  token?: string;
  body?: unknown;
  idempotencyKey?: string;
  retries?: number;
  timeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Cliente HTTP mínimo para a API do Mercado Pago.
 * Só repete a chamada quando é seguro: GET, ou POST/PUT com X-Idempotency-Key.
 */
export async function mpRequest<T>(path: string, opts: MpRequestOptions = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const safeToRetry = method === 'GET' || Boolean(opts.idempotencyKey);
  const maxRetries = safeToRetry ? (opts.retries ?? 2) : 0;

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.idempotencyKey) headers['X-Idempotency-Key'] = opts.idempotencyKey;

  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${MP_API}${path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
    } catch (err) {
      if (attempt < maxRetries) { await sleep(500 * 2 ** attempt); continue; }
      throw err;
    }

    const text = await res.text();
    const body = text ? safeJson(text) : null;
    if (res.ok) return body as T;

    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < maxRetries) { await sleep(500 * 2 ** attempt); continue; }

    // Nunca inclua headers (Authorization) na mensagem de erro.
    throw new MercadoPagoError(res.status, body, `Mercado Pago ${method} ${path} -> ${res.status}`);
  }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return { raw: text }; }
}
