import { z } from 'zod';

// Variáveis vazias no .env contam como ausentes
const optionalString = z.string().optional().transform((v) => (v ? v : undefined));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(3333),
  ENABLE_JOBS: z.string().default('false').transform((v) => v === 'true'),

  DATABASE_URL: z.string().min(1),

  // Autenticação dos operadores (Firebase Auth / Google)
  FIREBASE_PROJECT_ID: z.string().min(1),

  // CORS: lista de origens exatas separadas por vírgula (sem barra no final)
  CORS_ORIGINS: z.string().min(1),
  // Opcional: regex para deploy previews do Netlify
  CORS_ORIGIN_REGEX: z.string().optional(),

  MP_CLIENT_ID: z.string().min(1),
  MP_CLIENT_SECRET: z.string().min(1),
  MP_REDIRECT_URI: z.string().url(),
  MP_AUTH_BASE_URL: z.string().url().default('https://auth.mercadopago.com.br/authorization'),
  MP_WEBHOOK_SECRET: z.string().min(1),
  MP_PLATFORM_ACCESS_TOKEN: z.string().min(1),
  MP_PLATFORM_USER_ID: z.string().regex(/^\d+$/).transform((v) => BigInt(v)),

  TOKEN_ENC_KEYS: z.string().min(1),
  TOKEN_ENC_ACTIVE_KID: z.string().regex(/^[a-zA-Z0-9_-]+$/),

  OAUTH_STATE_TTL_HOURS: z.coerce.number().int().positive().default(48),
  TOKEN_REFRESH_WINDOW_DAYS: z.coerce.number().int().positive().default(30),
  APP_PUBLIC_URL: z.string().url(),

  // Cobranças
  PIX_DEFAULT_PAYER_EMAIL: z.string().email(), // Pix de balcão: comprador anônimo
  PIX_BALCAO_EXPIRATION_MINUTES: z.coerce.number().int().min(5).max(1440).default(30),
  LINK_EXPIRATION_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  AVULSA_EXPIRATION_HOURS: z.coerce.number().int().min(1).max(720).default(24),

  // Auditoria diária
  AUDIT_CRON: z.string().default('0 6 * * *'),          // 06:00 de São Paulo, audita D-1
  AUDIT_BACKFILL_DAYS: z.coerce.number().int().min(1).max(31).default(7),
  BYPASS_MIN_AMOUNT: z.coerce.number().min(0).default(10), // R$ fora do split p/ contar desvio
  BYPASS_MIN_COUNT: z.coerce.number().int().min(1).default(1),

  // WhatsApp Cloud API (opcional). Sem isso, o operador envia pelo link wa.me.
  WHATSAPP_TOKEN: optionalString,
  WHATSAPP_PHONE_NUMBER_ID: optionalString,
  WHATSAPP_TEMPLATE_COBRANCA: optionalString,
  WHATSAPP_TEMPLATE_LANG: z.string().default('pt_BR'),
  WHATSAPP_API_VERSION: z.string().default('v21.0'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Falha cedo e alto: melhor não subir do que subir sem segredo.
  console.error('Variáveis de ambiente inválidas:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
