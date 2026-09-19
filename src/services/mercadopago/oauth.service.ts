import { Prisma } from '@prisma/client';
import { env } from '../../config/env';
import { prisma } from '../../lib/prisma';
import { encryptSecret, decryptSecret, tokenAad, isEncryptedWithActiveKey } from '../../lib/crypto';
import { generatePkcePair, generateState } from '../../lib/pkce';
import { mpRequest, MercadoPagoError } from './http';
import type { MpTokenResponse } from './types';

export class OAuthFlowError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'OAuthFlowError';
  }
}

// ---------------------------------------------------------------------------
// 1) URL de autorização
// ---------------------------------------------------------------------------
export async function createAuthorizationUrl(merchantId: string, operatorId?: string) {
  const merchant = await prisma.merchant.findUnique({ where: { id: merchantId } });
  if (!merchant) throw new OAuthFlowError('merchant_not_found', 'Comerciante não encontrado');
  if (merchant.status === 'ACTIVE') {
    throw new OAuthFlowError('already_linked', 'Comerciante já vinculado');
  }

  const state = generateState();
  const pkce = generatePkcePair();
  const expiresAt = new Date(Date.now() + env.OAUTH_STATE_TTL_HOURS * 3600_000);

  await prisma.$transaction([
    // Invalida links antigos ainda não usados deste comerciante
    prisma.oAuthState.updateMany({
      where: { merchantId, usedAt: null },
      data: { expiresAt: new Date() },
    }),
    prisma.oAuthState.create({
      data: { state, merchantId, codeVerifier: pkce.verifier, expiresAt },
    }),
    prisma.auditLog.create({
      data: {
        operatorId,
        actor: operatorId ? `operator:${operatorId}` : 'system',
        action: 'oauth.link_created',
        entity: 'Merchant',
        entityId: merchantId,
      },
    }),
  ]);

  const url = new URL(env.MP_AUTH_BASE_URL);
  url.searchParams.set('client_id', env.MP_CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('platform_id', 'mp');
  url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri', env.MP_REDIRECT_URI);
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', pkce.method);

  return { authorizationUrl: url.toString(), expiresAt };
}

// ---------------------------------------------------------------------------
// 2) Callback: valida state, troca code (+ code_verifier) por tokens
// ---------------------------------------------------------------------------
export async function handleOAuthCallback(code: string, state: string) {
  // Consumo atômico do state: só UMA requisição consegue marcar usedAt.
  const consumed = await prisma.oAuthState.updateMany({
    where: { state, usedAt: null, expiresAt: { gt: new Date() } },
    data: { usedAt: new Date() },
  });
  if (consumed.count !== 1) {
    throw new OAuthFlowError('invalid_state', 'Link de vinculação inválido, expirado ou já utilizado');
  }
  const stateRow = await prisma.oAuthState.findUniqueOrThrow({ where: { state } });

  let token: MpTokenResponse;
  try {
    token = await mpRequest<MpTokenResponse>('/oauth/token', {
      method: 'POST',
      body: {
        client_id: env.MP_CLIENT_ID,
        client_secret: env.MP_CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: env.MP_REDIRECT_URI,
        code_verifier: stateRow.codeVerifier ?? undefined,
      },
    });
  } catch (err) {
    if (err instanceof MercadoPagoError) {
      throw new OAuthFlowError('token_exchange_failed', `Troca de código falhou (${err.status})`);
    }
    throw err;
  }

  const mpUserId = BigInt(token.user_id);
  if (mpUserId === env.MP_PLATFORM_USER_ID) {
    throw new OAuthFlowError('platform_account', 'A conta matriz não pode ser vinculada como comerciante');
  }

  const other = await prisma.merchant.findFirst({
    where: { mpUserId, NOT: { id: stateRow.merchantId } },
    select: { id: true },
  });
  if (other) {
    throw new OAuthFlowError('account_in_use', 'Esta conta Mercado Pago já está vinculada a outro comerciante');
  }

  await saveTokens(stateRow.merchantId, token, 'oauth.linked');
  return { merchantId: stateRow.merchantId, mpUserId };
}

async function saveTokens(merchantId: string, token: MpTokenResponse, action: string) {
  const data = {
    accessTokenEnc: encryptSecret(token.access_token, tokenAad(merchantId, 'access')),
    refreshTokenEnc: encryptSecret(token.refresh_token, tokenAad(merchantId, 'refresh')),
    publicKey: token.public_key ?? null,
    scope: token.scope,
    liveMode: token.live_mode,
    expiresAt: new Date(Date.now() + token.expires_in * 1000),
    lastRefreshedAt: new Date(),
    refreshFailures: 0,
  };

  await prisma.$transaction([
    prisma.oAuthToken.upsert({
      where: { merchantId },
      create: { merchantId, ...data },
      update: data,
    }),
    prisma.merchant.update({
      where: { id: merchantId },
      data: { mpUserId: BigInt(token.user_id), status: 'ACTIVE' },
    }),
    prisma.auditLog.create({
      data: {
        actor: 'system:oauth',
        action,
        entity: 'Merchant',
        entityId: merchantId,
        after: { mpUserId: String(token.user_id), liveMode: token.live_mode, expiresAt: data.expiresAt },
      },
    }),
  ]);
}

// ---------------------------------------------------------------------------
// 3) Renovação com trava de linha (evita dois workers queimando o mesmo
//    refresh_token — o MP devolve um refresh_token NOVO a cada renovação).
// ---------------------------------------------------------------------------
export type RefreshResult = 'refreshed' | 'skipped' | 'revoked' | 'failed';

export async function refreshMerchantToken(merchantId: string, force = false): Promise<RefreshResult> {
  const windowMs = env.TOKEN_REFRESH_WINDOW_DAYS * 86400_000;

  return prisma.$transaction(
    async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "OAuthToken" WHERE "merchantId" = ${merchantId}::uuid FOR UPDATE SKIP LOCKED`;
      if (locked.length === 0) return 'skipped'; // outro worker está renovando

      const row = await tx.oAuthToken.findUniqueOrThrow({ where: { merchantId } });
      if (!force && row.expiresAt.getTime() - Date.now() > windowMs) return 'skipped';

      const refreshToken = decryptSecret(row.refreshTokenEnc, tokenAad(merchantId, 'refresh'));

      try {
        const token = await mpRequest<MpTokenResponse>('/oauth/token', {
          method: 'POST',
          body: {
            client_id: env.MP_CLIENT_ID,
            client_secret: env.MP_CLIENT_SECRET,
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
          },
        });

        await tx.oAuthToken.update({
          where: { merchantId },
          data: {
            accessTokenEnc: encryptSecret(token.access_token, tokenAad(merchantId, 'access')),
            refreshTokenEnc: encryptSecret(token.refresh_token, tokenAad(merchantId, 'refresh')),
            publicKey: token.public_key ?? row.publicKey,
            scope: token.scope,
            expiresAt: new Date(Date.now() + token.expires_in * 1000),
            lastRefreshedAt: new Date(),
            refreshFailures: 0,
          },
        });
        await tx.auditLog.create({
          data: { actor: 'system:cron-refresh', action: 'oauth.refreshed', entity: 'Merchant', entityId: merchantId },
        });
        return 'refreshed';
      } catch (err) {
        if (err instanceof MercadoPagoError && err.isInvalidGrant) {
          // Comerciante revogou o acesso ou o refresh_token morreu.
          await tx.merchant.update({ where: { id: merchantId }, data: { status: 'OAUTH_REVOKED' } });
          await tx.alert.create({
            data: {
              merchantId,
              type: 'OAUTH_REVOKED',
              severity: 'CRITICAL',
              title: 'Acesso Mercado Pago revogado ou expirado',
              details: { httpStatus: err.status, body: err.body as Prisma.InputJsonValue },
            },
          });
          return 'revoked';
        }

        const updated = await tx.oAuthToken.update({
          where: { merchantId },
          data: { refreshFailures: { increment: 1 } },
        });
        if (updated.refreshFailures === 3) {
          await tx.alert.create({
            data: {
              merchantId,
              type: 'OAUTH_REFRESH_FAILED',
              severity: 'WARNING',
              title: 'Falha repetida ao renovar token Mercado Pago',
              details: { failures: updated.refreshFailures, error: String(err) },
            },
          });
        }
        return 'failed';
      }
    },
    { timeout: 30_000, maxWait: 5_000 },
  );
}

// ---------------------------------------------------------------------------
// 4) Obter access_token válido (usado por webhook, cobranças e auditoria)
// ---------------------------------------------------------------------------
export async function getMerchantAccessToken(merchantId: string): Promise<string> {
  let row = await prisma.oAuthToken.findUnique({
    where: { merchantId },
    include: { merchant: { select: { status: true } } },
  });
  if (!row) throw new OAuthFlowError('not_linked', 'Comerciante sem token OAuth');
  if (row.merchant.status === 'OAUTH_REVOKED') {
    throw new OAuthFlowError('revoked', 'Acesso do comerciante revogado');
  }

  // Rede de segurança: se o cron falhou e faltam < 24h, renova na hora.
  if (row.expiresAt.getTime() - Date.now() < 86400_000) {
    const result = await refreshMerchantToken(merchantId, true);
    if (result === 'revoked') throw new OAuthFlowError('revoked', 'Acesso do comerciante revogado');
    row = await prisma.oAuthToken.findUniqueOrThrow({
      where: { merchantId },
      include: { merchant: { select: { status: true } } },
    });
  }

  const access = decryptSecret(row.accessTokenEnc, tokenAad(merchantId, 'access'));

  // Rotação de chave preguiçosa: regrava com a chave ativa na primeira leitura.
  if (!isEncryptedWithActiveKey(row.accessTokenEnc) || !isEncryptedWithActiveKey(row.refreshTokenEnc)) {
    const refresh = decryptSecret(row.refreshTokenEnc, tokenAad(merchantId, 'refresh'));
    await prisma.oAuthToken.update({
      where: { merchantId },
      data: {
        accessTokenEnc: encryptSecret(access, tokenAad(merchantId, 'access')),
        refreshTokenEnc: encryptSecret(refresh, tokenAad(merchantId, 'refresh')),
      },
    });
  }
  return access;
}
