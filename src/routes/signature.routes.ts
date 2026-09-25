import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { dbDateToYmd } from '../lib/dates';
import { getSegment } from '../services/credit/segments';
import { shortHash } from '../services/credit/contract.service';
import { getSettings } from '../services/credit/settings.service';

/**
 * ROTAS PÚBLICAS DA ASSINATURA — sem login.
 * A única credencial é o token do link, que:
 *  - é aleatório de 32 bytes,
 *  - expira (padrão: 72h),
 *  - vale para um único contrato,
 *  - deixa de funcionar assim que o aceite é registrado.
 * Nenhum dado de outro cliente é acessível por aqui.
 */

const MAX_FILE = 6 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']);
const REQUIRED_DOCS = ['DOC_FRONT', 'DOC_SELFIE', 'ADDRESS_PROOF'] as const;

const money = (d: Prisma.Decimal) => Number(d).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const onlyDigits = (s: string) => s.replace(/\D/g, '');

/** Compara nomes ignorando acentos, caixa e espaços extras. */
function sameName(a: string, b: string): boolean {
  const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  return norm(a) === norm(b);
}

type LoadError = 'invalid' | 'expired' | 'already_signed' | 'unavailable';

type Loaded =
  | { ok: false; error: LoadError }
  | { ok: true; sig: NonNullable<Awaited<ReturnType<typeof findSignature>>> };

function findSignature(token: string) {
  return prisma.contractSignature.findUnique({
    where: { token },
    include: { contract: { include: { borrower: true, documents: { select: { kind: true } } } } },
  });
}

async function loadByToken(token: string): Promise<Loaded> {
  const sig = await findSignature(token);
  if (!sig) return { ok: false, error: 'invalid' };
  if (sig.acceptedAt) return { ok: false, error: 'already_signed' };
  if (sig.expiresAt < new Date()) return { ok: false, error: 'expired' };
  if (sig.contract.status !== 'AWAITING_SIGNATURE') return { ok: false, error: 'unavailable' };
  return { ok: true, sig };
}

const ERROS: Record<LoadError, string> = {
  invalid: 'Link inválido. Peça um novo link para o seu contato.',
  expired: 'Este link expirou. Peça um novo link para o seu contato.',
  already_signed: 'Este contrato já foi assinado. Se precisar de uma cópia, fale com o seu contato.',
  unavailable: 'Este contrato não está mais disponível para assinatura.',
};

export async function signatureRoutes(app: FastifyInstance) {
  // Limite generoso, mas suficiente para travar tentativa de adivinhar token.
  const limit = { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };

  /** Dados da proposta para a tela do cliente. */
  app.get('/p/contrato/:token', limit, async (req, reply) => {
    const { token } = z.object({ token: z.string().min(20).max(120) }).parse(req.params);
    const r = await loadByToken(token);
    if (!r.ok) return reply.code(410).send({ error: r.error, message: ERROS[r.error] });

    const c = r.sig.contract;
    const settings = await getSettings();
    if (!r.sig.openedAt) await prisma.contractSignature.update({ where: { token }, data: { openedAt: new Date() } });

    const enviados = new Set(c.documents.map((d) => d.kind));
    return {
      contractNumber: c.number,
      company: settings.companyName,
      borrowerName: c.borrower.name,
      borrowerDocument: c.borrower.document.length === 11
        ? `***.${c.borrower.document.slice(3, 6)}.${c.borrower.document.slice(6, 9)}-**`
        : c.borrower.document,
      segmentLabel: getSegment(c.borrower.segment).label,
      principal: money(c.principal),
      netToBorrower: money(c.netToBorrower.greaterThan(0) ? c.netToBorrower : c.principal),
      costsTotal: money(c.costsTotal),
      costsLines: ((c.costsBreakdown as { lines?: Array<{ label: string; value: number }> } | null)?.lines ?? [])
        .map((l) => ({ label: l.label, value: Number(l.value).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) })),
      totalPayable: money(c.totalPayable),
      installmentAmount: money(c.installmentAmount),
      installmentsCount: c.installmentsCount,
      frequency: c.frequency,
      firstDueDate: dbDateToYmd(c.firstDueDate),
      cetLabel: `${(Number(c.cetMonthly) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}% ao mês`,
      payToPixKey: c.payToPixKey,
      contractText: c.contractText,
      hash: shortHash(c.contractHash),
      expiresAt: r.sig.expiresAt,
      documentsSent: {
        DOC_FRONT: enviados.has('DOC_FRONT'),
        DOC_SELFIE: enviados.has('DOC_SELFIE'),
        ADDRESS_PROOF: enviados.has('ADDRESS_PROOF'),
      },
    };
  });

  /** Upload de um documento (um por requisição). */
  app.post('/p/contrato/:token/documento', limit, async (req, reply) => {
    const { token } = z.object({ token: z.string().min(20).max(120) }).parse(req.params);
    const r = await loadByToken(token);
    if (!r.ok) return reply.code(410).send({ error: r.error, message: ERROS[r.error] });

    const file = await req.file({ limits: { fileSize: MAX_FILE } });
    if (!file) return reply.code(400).send({ error: 'no_file', message: 'Nenhum arquivo recebido. Tente novamente.' });

    const kindRaw = (file.fields as Record<string, { value?: string } | undefined>)?.kind?.value;
    const kind = z.enum(REQUIRED_DOCS).safeParse(kindRaw);
    if (!kind.success) return reply.code(400).send({ error: 'bad_kind', message: 'Tipo de documento inválido.' });
    if (!ACCEPTED_TYPES.has(file.mimetype)) {
      return reply.code(415).send({ error: 'bad_type', message: 'Envie uma foto (JPG ou PNG) ou um PDF.' });
    }

    const buf = await file.toBuffer();
    if (file.file.truncated || buf.length > MAX_FILE) {
      return reply.code(413).send({ error: 'too_large', message: 'A imagem passou de 6 MB. Tire a foto com qualidade menor e tente de novo.' });
    }

    const c = r.sig.contract;
    await prisma.$transaction([
      prisma.borrowerDocument.deleteMany({ where: { contractId: c.id, kind: kind.data } }), // substitui o envio anterior
      prisma.borrowerDocument.create({
        data: { borrowerId: c.borrowerId, contractId: c.id, kind: kind.data, mimeType: file.mimetype, sizeBytes: buf.length, data: new Uint8Array(buf), uploadedIp: req.ip },
      }),
    ]);

    const enviados = await prisma.borrowerDocument.findMany({ where: { contractId: c.id }, select: { kind: true } });
    const set = new Set(enviados.map((d) => d.kind));
    return { ok: true, documentsSent: { DOC_FRONT: set.has('DOC_FRONT'), DOC_SELFIE: set.has('DOC_SELFIE'), ADDRESS_PROOF: set.has('ADDRESS_PROOF') } };
  });

  /** Aceite: registra assinatura, IP, dispositivo e a chave Pix de recebimento. */
  app.post('/p/contrato/:token/aceite', limit, async (req, reply) => {
    const { token } = z.object({ token: z.string().min(20).max(120) }).parse(req.params);
    const body = z.object({
      typedSignature: z.string().trim().min(5).max(200),
      signerDocument: z.string().transform(onlyDigits).refine((v) => v.length === 11 || v.length === 14, 'CPF ou CNPJ inválido'),
      pixKey: z.string().trim().min(3).max(150),
      pixKeyType: z.enum(['CPF', 'CNPJ', 'CELULAR', 'EMAIL', 'ALEATORIA']),
      agreed: z.literal(true),
    }).parse(req.body);

    const r = await loadByToken(token);
    if (!r.ok) return reply.code(410).send({ error: r.error, message: ERROS[r.error] });
    const c = r.sig.contract;

    const enviados = new Set(c.documents.map((d) => d.kind));
    const faltando = REQUIRED_DOCS.filter((k) => !enviados.has(k));
    if (faltando.length) {
      return reply.code(422).send({ error: 'missing_docs', message: 'Envie os três documentos antes de assinar.', missing: faltando });
    }

    if (!sameName(body.typedSignature, c.borrower.name)) {
      return reply.code(422).send({ error: 'name_mismatch', message: 'Digite seu nome completo exatamente como está no cadastro.' });
    }
    if (body.signerDocument !== c.borrower.document) {
      return reply.code(422).send({ error: 'document_mismatch', message: 'O CPF/CNPJ informado não confere com o do contrato.' });
    }

    const now = new Date();
    await prisma.$transaction([
      prisma.contractSignature.update({
        where: { token },
        data: {
          acceptedAt: now, signerName: c.borrower.name, signerDocument: body.signerDocument,
          signerIp: req.ip, signerUserAgent: String(req.headers['user-agent'] ?? '').slice(0, 300),
          signerPixKey: body.pixKey, signerPixKeyType: body.pixKeyType, typedSignature: body.typedSignature,
        },
      }),
      prisma.creditContract.update({
        where: { id: c.id },
        data: { status: 'SIGNED', signedAt: now, receivePixKey: body.pixKey },
      }),
      prisma.auditLog.create({
        data: {
          actor: 'cliente:assinatura', action: 'credit.contract.signed', entity: 'CreditContract', entityId: c.id,
          ip: req.ip,
          after: { contractHash: c.contractHash, signerDocument: body.signerDocument, pixKeyType: body.pixKeyType, userAgent: String(req.headers['user-agent'] ?? '').slice(0, 300) } as Prisma.InputJsonValue,
        },
      }),
    ]);

    return {
      ok: true,
      contractNumber: c.number,
      hash: shortHash(c.contractHash),
      signedAt: now,
      message: 'Contrato assinado. O valor será enviado para a sua chave Pix após a conferência dos documentos.',
    };
  });
}
