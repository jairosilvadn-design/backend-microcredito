import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { requireOperator } from '../plugins/auth';
import {
  ChargeError,
  createAvulsa,
  createPaymentLink,
  createPixBalcao,
  toChargeDto,
} from '../services/charges.service';

// ----------------------------- validação ------------------------------------
const money = z.number().positive().max(50_000).multipleOf(0.01);
const cpf = z.string().regex(/^\d{11}$/, 'CPF com 11 dígitos, só números');

const pixBalcaoSchema = z.object({
  merchantId: z.string().uuid(),
  amount: money,
  description: z.string().max(250).optional(),
  payerEmail: z.string().email().optional(),
  payerCpf: cpf.optional(),
});

const linkSchema = z.object({
  merchantId: z.string().uuid(),
  amount: money,
  title: z.string().min(3).max(250),
  payerEmail: z.string().email().optional(),
  expiresInHours: z.number().int().min(1).max(720).optional(),
});

const avulsaSchema = z.object({
  merchantId: z.string().uuid(),
  amount: money.optional(),
  reason: z.enum(['LOW_VOLUME', 'OVERDUE', 'CONTRACT_BREACH', 'MANUAL']).default('MANUAL'),
});

/** Header obrigatório: um UUID novo por intenção de cobrança (gerado no frontend). */
function idempotencyKey(req: FastifyRequest): string {
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || !/^[A-Za-z0-9-]{16,64}$/.test(key)) {
    throw new ChargeError('missing_idempotency_key', 400, 'Envie o header Idempotency-Key (UUID)');
  }
  return key;
}

function handleError(err: unknown, reply: FastifyReply, req: FastifyRequest) {
  if (err instanceof z.ZodError) {
    return reply.code(400).send({ error: 'validation_error', details: err.flatten().fieldErrors });
  }
  if (err instanceof ChargeError) {
    if (err.httpStatus >= 500) req.log.error({ err }, 'Falha ao criar cobrança');
    return reply.code(err.httpStatus).send({ error: err.code, message: err.message });
  }
  req.log.error({ err }, 'Erro inesperado');
  return reply.code(500).send({ error: 'internal_error', message: 'Erro inesperado' });
}

// ------------------------------- rotas --------------------------------------
export async function chargesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireOperator);

  // Limite por sessão (hash do token), não por IP: evita que um bug no front
  // dispare centenas de Pix. O rate limit roda antes da autenticação, por isso o hash.
  const keyGenerator = (r: FastifyRequest) =>
    r.headers.authorization ? createHash('sha256').update(r.headers.authorization).digest('hex') : r.ip;
  const limit = { config: { rateLimit: { max: 30, timeWindow: '1 minute', keyGenerator } } };

  app.post('/api/charges/pix-balcao', limit, async (req, reply) => {
    try {
      const body = pixBalcaoSchema.parse(req.body);
      const dto = await createPixBalcao({ ...body, idempotencyKey: idempotencyKey(req), operatorId: req.operator!.id });
      return reply.code(dto.replayed ? 200 : 201).send(dto);
    } catch (err) {
      return handleError(err, reply, req);
    }
  });

  app.post('/api/charges/link-pagamento', limit, async (req, reply) => {
    try {
      const body = linkSchema.parse(req.body);
      const dto = await createPaymentLink({ ...body, idempotencyKey: idempotencyKey(req), operatorId: req.operator!.id });
      return reply.code(dto.replayed ? 200 : 201).send(dto);
    } catch (err) {
      return handleError(err, reply, req);
    }
  });

  app.post('/api/charges/avulsa', limit, async (req, reply) => {
    try {
      const body = avulsaSchema.parse(req.body);
      const dto = await createAvulsa({ ...body, idempotencyKey: idempotencyKey(req), operatorId: req.operator!.id });
      return reply.code(dto.replayed ? 200 : 201).send(dto);
    } catch (err) {
      return handleError(err, reply, req);
    }
  });

  /** Status leve para polling da tela do balcão (sem o PNG base64). */
  app.get('/api/charges/:id/status', async (req, reply) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const c = await prisma.charge.findUnique({ where: { id } });
    if (!c) return reply.code(404).send({ error: 'not_found' });
    const expired = c.status === 'PENDING' && c.expiresAt != null && c.expiresAt < new Date();
    const { qrCodeBase64: _omit, ...dto } = toChargeDto(c);
    return reply.send({ ...dto, status: expired ? 'EXPIRED' : c.status, approvedAt: c.approvedAt });
  });
}
