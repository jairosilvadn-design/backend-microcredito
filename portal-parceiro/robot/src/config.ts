import { z } from 'zod';

const schema = z.object({
  ITAU_URL_LOGIN: z.string().url(),
  ITAU_USUARIO: z.string().min(1),
  ITAU_SENHA: z.string().min(1),
  ITAU_CODIGO_CORRESPONDENTE: z.string().optional(),
  FIREBASE_SERVICE_ACCOUNT_B64: z.string().min(10),
  ROBO_CONCURRENCY: z.coerce.number().int().min(1).max(5).default(1),
  ROBO_TIMEOUT_MS: z.coerce.number().int().default(60_000),
  ROBO_MAX_TENTATIVAS: z.coerce.number().int().default(3),
  ROBO_LOCK_TTL_MS: z.coerce.number().int().default(300_000),
  HEADLESS: z.enum(['true', 'false']).default('true'),
});
export const config = schema.parse(process.env); // falha no boot se faltar algo
