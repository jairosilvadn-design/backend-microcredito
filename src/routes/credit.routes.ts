import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { addDaysYmd, dbDateToYmd, isValidYmd, ymdSaoPaulo, ymdToDbDate } from '../lib/dates';
import { requireAdmin, requireOperator } from '../plugins/auth';
import { SEGMENTS, estimateCapacity, getSegment, suggestPrincipal } from '../services/credit/segments';
import { quote as buildQuote, lateCharge, computeCosts } from '../services/credit/pricing.service';
import { parseStatement, summarize } from '../services/credit/statement.service';
import { buildContractText, buildMessage, hashContract, shortHash, waLink } from '../services/credit/contract.service';
import { canLendTo, ensureLevels, getSettings, saveSettings } from '../services/credit/settings.service';
import {
  MODOS, PADROES, limiteParaCliente, modoPara, projetarCaixa, recomendacoes, saudeDaCarteira, situacaoCaixa,
} from '../services/credit/tesouraria.service';
import { env } from '../config/env';

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const money2 = (d: Prisma.Decimal | null | undefined) => (d == null ? null : d.toFixed(2));
const real = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const num = (d: Prisma.Decimal | null | undefined) => (d == null ? 0 : Number(d));
const onlyDigits = (s: string) => s.replace(/\D/g, '');
const uuid = z.string().uuid();
const MAX_UPLOAD = 6 * 1024 * 1024; // 6 MB por arquivo
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

function normalizeWhatsapp(raw: string): string | null {
  let d = onlyDigits(raw);
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  if (!(d.length === 12 || d.length === 13) || !d.startsWith('55')) return null;
  return `+${d}`;
}

async function audit(req: FastifyRequest, action: string, entity: string, entityId: string, after?: unknown) {
  await prisma.auditLog.create({
    data: {
      operatorId: req.operator?.id ?? null,
      actor: req.operator ? `operator:${req.operator.email}` : 'system',
      action, entity, entityId,
      after: (after ?? {}) as Prisma.InputJsonValue,
      ip: req.ip,
    },
  });
}

/** Número sequencial do contrato: CT-2026-0007 */
async function nextContractNumber(): Promise<string> {
  const year = ymdSaoPaulo().slice(0, 4);
  const count = await prisma.creditContract.count({ where: { number: { startsWith: `CT-${year}-` } } });
  return `CT-${year}-${String(count + 1).padStart(4, '0')}`;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const borrowerSchema = z.object({
  personType: z.enum(['PF', 'PJ']),
  document: z.string().transform(onlyDigits).refine((v) => v.length === 11 || v.length === 14, 'CPF (11) ou CNPJ (14) dígitos'),
  name: z.string().trim().min(3).max(200),
  tradeName: z.string().trim().max(200).optional().or(z.literal('').transform(() => undefined)),
  whatsapp: z.string().transform((v) => normalizeWhatsapp(v) ?? '').refine((v) => v !== '', 'WhatsApp inválido'),
  email: z.string().trim().email().optional().or(z.literal('').transform(() => undefined)),
  addressStreet: z.string().trim().max(200).optional(),
  addressNumber: z.string().trim().max(20).optional(),
  addressDistrict: z.string().trim().max(100).optional(),
  addressCity: z.string().trim().min(2).max(100),
  addressState: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/),
  addressZip: z.string().trim().max(20).optional(),
  segment: z.string().refine((s) => SEGMENTS.some((x) => x.key === s), 'Segmento inválido'),
  segmentOther: z.string().trim().max(100).optional(),
  businessMonths: z.coerce.number().int().min(0).max(1200).default(0),
  openDaysPerWeek: z.coerce.number().int().min(1).max(7).default(6),
  declaredDailySales: z.coerce.number().min(0).max(1_000_000).optional(),
  ownsPoint: z.coerce.boolean().default(false),
  referredBy: z.string().trim().max(200).optional(),
  notes: z.string().trim().max(2000).optional(),
  consent: z.literal(true),
});

const quoteSchema = z.object({
  borrowerId: uuid,
  principal: z.coerce.number().positive().max(100_000),
  installments: z.coerce.number().int().min(2).max(120),
  frequency: z.enum(['DAILY', 'WEEKLY']),
  firstDueDate: z.string().refine(isValidYmd),
  ratePercent: z.coerce.number().min(0).max(100).optional(),
  levelId: uuid.optional(),
  purpose: z.string().trim().max(200).optional(),
  ignorarLimite: z.boolean().default(false), // o operador pode assumir o risco
});

/** Soma de tudo que entrou e saiu do caixa. */
async function saldoDoCaixa(): Promise<number> {
  const r = await prisma.cashEntry.aggregate({ _sum: { amount: true } });
  return Number(r._sum.amount ?? 0);
}

/** Retrato completo da operação: caixa, saúde, projeção e o que fazer hoje. */
async function retratoDaOperacao() {
  const hoje = ymdSaoPaulo();
  const [saldo, contratos, parcelas, aguardando, assinados, prontos, ultimaLiberacao] = await Promise.all([
    saldoDoCaixa(),
    prisma.creditContract.findMany({
      where: { status: { in: ['ACTIVE', 'DEFAULTED'] } },
      select: { principal: true, totalPayable: true, outstanding: true, disbursedAt: true },
    }),
    prisma.creditInstallment.findMany({
      where: { contract: { status: { in: ['ACTIVE', 'DEFAULTED'] } }, status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] } },
      select: { dueDate: true, amountDue: true, amountPaid: true, lateCharge: true, status: true },
    }),
    prisma.creditContract.count({ where: { status: 'AWAITING_SIGNATURE' } }),
    prisma.creditContract.count({ where: { status: 'SIGNED' } }),
    prisma.borrower.count({ where: { status: 'EM_DIA', contracts: { none: { status: { in: ['DRAFT', 'AWAITING_SIGNATURE', 'SIGNED', 'ACTIVE'] } } } } }),
    prisma.cashEntry.findFirst({ where: { kind: 'LIBERACAO' }, orderBy: { happenedAt: 'desc' } }),
  ]);

  // Capital na rua = parte do principal ainda não devolvida (proporcional ao pago)
  let principalNaRua = 0, carteiraTotal = 0, liberadoTotal = 0, jurosRecebidos = 0;
  for (const c of contratos) {
    const principal = num(c.principal), total = num(c.totalPayable), aberto = num(c.outstanding);
    const fatia = total > 0 ? principal / total : 1;
    principalNaRua += aberto * fatia;
    carteiraTotal += aberto;
    liberadoTotal += principal;
    jurosRecebidos += (total - aberto) * (1 - fatia);
  }

  let atrasoAte30 = 0, atrasoMais30 = 0, parcelasAtrasadas = 0;
  const entradasPorDia: Record<string, number> = {};
  for (const i of parcelas) {
    const dia = dbDateToYmd(i.dueDate);
    const falta = num(i.amountDue) + num(i.lateCharge) - num(i.amountPaid);
    const diasAtraso = Math.round((Date.parse(`${hoje}T12:00:00Z`) - Date.parse(`${dia}T12:00:00Z`)) / 86400_000);
    if (diasAtraso > 0) {
      parcelasAtrasadas++;
      if (diasAtraso > 30) atrasoMais30 += falta; else atrasoAte30 += falta;
      entradasPorDia[hoje] = (entradasPorDia[hoje] ?? 0) + falta; // atrasada: pode entrar hoje
    } else {
      entradasPorDia[dia] = (entradasPorDia[dia] ?? 0) + falta;
    }
  }

  // O modo depende do tamanho da carteira: carteira pequena roda mais solta.
  const settings = await getSettings();
  const modo = modoPara(saldo + principalNaRua, settings.modoOperacao);
  const padroes = modo.padroes;

  const caixa = situacaoCaixa({ saldoCaixa: saldo, principalNaRua, aReceberProximos7Dias: 0, padroes });
  const saude = saudeDaCarteira({
    padroes,
    carteiraTotal, emAtrasoAte30: atrasoAte30, emAtrasoMais30: atrasoMais30, liberadoTotal, jurosRecebidos,
    diasOperando: Math.max(1, contratos.reduce((mx, c) => {
      if (!c.disbursedAt) return mx;
      return Math.max(mx, Math.round((Date.now() - c.disbursedAt.getTime()) / 86400_000));
    }, 0)),
    saldoCaixa: saldo,
  });

  const dias = Array.from({ length: 60 }, (_, k) => addDaysYmd(hoje, k));
  const projecao = projetarCaixa({
    saldoHoje: saldo, reserva: caixa.reservaGuardada, entradasPorDia, dias, contratoMinimo: padroes.contratoMinimo,
  });

  const diasCaixaParado = ultimaLiberacao
    ? Math.round((Date.now() - ultimaLiberacao.happenedAt.getTime()) / 86400_000)
    : 0;

  const clientesAtivos = await prisma.borrower.count({ where: { status: { in: ['ATIVO', 'ATRASADO', 'INADIMPLENTE'] } } });
  const tarefas = recomendacoes({
    padroes,
    caixa, saude, projecao, clientesAtivos, clientesProntosParaSubir: prontos,
    parcelasAtrasadas, contratosAguardandoAssinatura: aguardando, contratosAssinadosSemLiberar: assinados,
    diasCaixaParado: caixa.disponivelParaEmprestar >= padroes.contratoMinimo ? diasCaixaParado : 0,
  });

  return { caixa, saude, projecao, tarefas, principalNaRua, carteiraTotal, clientesAtivos, parcelasAtrasadas, modo, padroes };
}

// ---------------------------------------------------------------------------
export async function creditRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireOperator);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof z.ZodError) {
      const fields = err.issues.map((i) => `${i.path.join('.') || 'campo'}: ${i.message}`);
      return reply.code(400).send({ error: 'validation_error', message: fields.slice(0, 4).join(' · ') });
    }
    req.log.error({ err }, 'Erro no módulo de crédito');
    return reply.code(500).send({ error: 'internal_error', message: 'Erro inesperado no servidor' });
  });

  // ------------------------------------------------- configuração e níveis
  app.get('/api/credito/config', async () => {
    await ensureLevels();
    const [settings, levels] = await Promise.all([
      getSettings(),
      prisma.creditLevel.findMany({ orderBy: { rank: 'asc' } }),
    ]);
    return {
      settings,
      levels: levels.map((l) => ({ ...l, maxPrincipal: money2(l.maxPrincipal), ratePercent: money2(l.ratePercent) })),
      segments: SEGMENTS,
      modos: MODOS,
    };
  });

  app.put('/api/credito/config', { preHandler: requireAdmin }, async (req) => {
    const body = z.object({
      companyName: z.string().trim().min(2).max(200).optional(),
      companyDocument: z.string().trim().max(20).optional(),
      companyAddress: z.string().trim().max(300).optional(),
      pixKey: z.string().trim().max(150).optional(),
      pixKeyLabel: z.string().trim().max(50).optional(),
      pixOwner: z.string().trim().max(200).optional(),
      regime: z.enum(['ESC', 'SCD', 'PARCEIRO_SCD']).optional(),
      partnerName: z.string().trim().max(200).optional(),
      lateFeePercent: z.coerce.number().min(0).max(2).optional(),   // CDC: teto de 2%
      lateDailyPercent: z.coerce.number().min(0).max(0.5).optional(),
      signatureTtlHours: z.coerce.number().int().min(1).max(720).optional(),
      maxPrincipalGlobal: z.coerce.number().min(50).max(100_000).optional(),
      minPrincipal: z.coerce.number().min(10).max(100_000).optional(),
      chargeIof: z.boolean().optional(),
      iofFixedPercent: z.coerce.number().min(0).max(10).optional(),
      iofDailyPercent: z.coerce.number().min(0).max(1).optional(),
      tacFixed: z.coerce.number().min(0).max(10_000).optional(),
      tacPercent: z.coerce.number().min(0).max(20).optional(),
      otherCosts: z.coerce.number().min(0).max(10_000).optional(),
      costsMode: z.enum(['DEDUZIR', 'FINANCIAR']).optional(),
      legalReviewer: z.string().trim().max(200).optional(),
      legalReviewerOab: z.string().trim().max(40).optional(),
      modoOperacao: z.enum(['AUTO', 'ARRANCADA', 'EQUILIBRADO', 'CONSERVADOR']).optional(),
    }).parse(req.body);
    const saved = await saveSettings(body);
    await audit(req, 'credit.settings.update', 'AppSetting', 'operation', body);
    return saved;
  });

  app.put('/api/credito/niveis/:id', { preHandler: requireAdmin }, async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({
      name: z.string().trim().min(2).max(60).optional(),
      maxPrincipal: z.coerce.number().min(50).max(100_000).optional(),
      ratePercent: z.coerce.number().min(0).max(100).optional(),
      maxTerm: z.coerce.number().int().min(2).max(120).optional(),
      active: z.boolean().optional(),
    }).parse(req.body);
    const level = await prisma.creditLevel.update({ where: { id }, data: body });
    await audit(req, 'credit.level.update', 'CreditLevel', id, body);
    return { ...level, maxPrincipal: money2(level.maxPrincipal), ratePercent: money2(level.ratePercent) };
  });

  // ---------------------------------------------------------- tomadores
  app.get('/api/credito/clientes', async (req) => {
    const { q, status } = z.object({ q: z.string().trim().max(100).optional(), status: z.string().optional() }).parse(req.query);
    const list = await prisma.borrower.findMany({
      where: {
        ...(status ? { status: status as never } : {}),
        ...(q ? { OR: [{ name: { contains: q, mode: 'insensitive' } }, { document: { contains: onlyDigits(q) } }, { tradeName: { contains: q, mode: 'insensitive' } }] } : {}),
      },
      include: {
        level: true,
        contracts: { where: { status: { in: ['DRAFT', 'AWAITING_SIGNATURE', 'SIGNED', 'ACTIVE'] } }, select: { id: true, number: true, status: true, outstanding: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return list.map((b) => ({
      id: b.id, name: b.name, tradeName: b.tradeName, document: b.document, personType: b.personType,
      whatsapp: b.whatsapp, city: `${b.addressCity}/${b.addressState}`, segment: b.segment,
      segmentLabel: getSegment(b.segment).label, status: b.status, score: b.score, cyclesPaid: b.cyclesPaid,
      level: b.level ? { rank: b.level.rank, name: b.level.name } : null,
      openContract: b.contracts[0] ? { ...b.contracts[0], outstanding: money2(b.contracts[0].outstanding) } : null,
    }));
  });

  app.post('/api/credito/clientes', async (req, reply) => {
    const data = borrowerSchema.parse(req.body);
    const settings = await getSettings();
    const rule = canLendTo(data.personType, settings.regime);
    if (!rule.allowed) return reply.code(409).send({ error: 'regime_blocked', message: rule.reason });
    if (data.personType === 'PF' && data.document.length !== 11) return reply.code(400).send({ error: 'validation_error', message: 'Pessoa física exige CPF com 11 dígitos' });
    if (data.personType === 'PJ' && data.document.length !== 14) return reply.code(400).send({ error: 'validation_error', message: 'Pessoa jurídica exige CNPJ com 14 dígitos' });

    const exists = await prisma.borrower.findUnique({ where: { document: data.document } });
    if (exists) return reply.code(409).send({ error: 'duplicate', message: 'Já existe cadastro com este CPF/CNPJ' });

    await ensureLevels();
    const level1 = await prisma.creditLevel.findFirst({ where: { rank: 1 } });
    const { consent: _c, declaredDailySales, ...rest } = data;

    const b = await prisma.borrower.create({
      data: {
        ...rest,
        declaredDailySales: declaredDailySales != null ? D(declaredDailySales) : null,
        levelId: level1?.id ?? null,
        consentAt: new Date(),
        score: estimateCapacity({ segment: data.segment, openDaysPerWeek: data.openDaysPerWeek, businessMonths: data.businessMonths, declaredDailySales, ownsPoint: data.ownsPoint, referred: Boolean(data.referredBy) }).score,
      },
    });
    await audit(req, 'credit.borrower.create', 'Borrower', b.id, { document: b.document, name: b.name });
    return reply.code(201).send({ id: b.id });
  });

  app.get('/api/credito/clientes/:id', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = await prisma.borrower.findUnique({
      where: { id },
      include: {
        level: true,
        analyses: { orderBy: { createdAt: 'desc' }, take: 5 },
        documents: { select: { id: true, kind: true, mimeType: true, sizeBytes: true, createdAt: true }, orderBy: { createdAt: 'desc' } },
        contracts: { orderBy: { createdAt: 'desc' }, include: { installments: { orderBy: { sequence: 'asc' } } } },
      },
    });
    if (!b) return reply.code(404).send({ error: 'not_found', message: 'Cliente não encontrado' });

    const lastAnalysis = b.analyses[0];
    const capacity = estimateCapacity({
      segment: b.segment, openDaysPerWeek: b.openDaysPerWeek, businessMonths: b.businessMonths,
      declaredDailySales: b.declaredDailySales ? num(b.declaredDailySales) : null,
      statementDailyAverage: lastAnalysis ? num(lastAnalysis.medianDaily) : null,
      ownsPoint: b.ownsPoint, referred: Boolean(b.referredBy), hasDocuments: b.documents.length > 0,
    });

    return {
      ...b,
      segmentLabel: getSegment(b.segment).label,
      declaredDailySales: money2(b.declaredDailySales),
      capacity,
      level: b.level ? { ...b.level, maxPrincipal: money2(b.level.maxPrincipal), ratePercent: money2(b.level.ratePercent) } : null,
      analyses: b.analyses.map((a) => ({ ...a, periodFrom: dbDateToYmd(a.periodFrom), periodTo: dbDateToYmd(a.periodTo), creditsTotal: money2(a.creditsTotal), medianDaily: money2(a.medianDaily), avgDailyCredits: money2(a.avgDailyCredits), suggestedDaily: money2(a.suggestedDaily) })),
      contracts: b.contracts.map((c) => ({
        id: c.id, number: c.number, status: c.status, principal: money2(c.principal), totalPayable: money2(c.totalPayable),
        outstanding: money2(c.outstanding), installmentAmount: money2(c.installmentAmount), frequency: c.frequency,
        installmentsCount: c.installmentsCount, firstDueDate: dbDateToYmd(c.firstDueDate),
        paid: c.installments.filter((i) => i.status === 'PAID').length,
        overdue: c.installments.filter((i) => i.status === 'OVERDUE').length,
        createdAt: c.createdAt, signedAt: c.signedAt, disbursedAt: c.disbursedAt,
      })),
    };
  });

  // ------------------------------------------------ extrato (opcional)
  app.post('/api/credito/clientes/:id/extrato', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const borrower = await prisma.borrower.findUnique({ where: { id } });
    if (!borrower) return reply.code(404).send({ error: 'not_found', message: 'Cliente não encontrado' });

    const file = await req.file({ limits: { fileSize: MAX_UPLOAD } });
    if (!file) return reply.code(400).send({ error: 'no_file', message: 'Envie um arquivo .csv ou .ofx do extrato' });
    const buf = await file.toBuffer();
    const { entries, source } = parseStatement(file.filename, buf.toString('utf8'));
    if (!entries.length) {
      return reply.code(422).send({ error: 'unreadable', message: 'Não consegui ler lançamentos neste arquivo. Use o extrato em CSV ou OFX exportado pelo banco.' });
    }

    const s = summarize(entries);
    const seg = getSegment(borrower.segment);
    const suggested = Math.round(s.medianDaily * seg.commitment * 100) / 100;

    const saved = await prisma.statementAnalysis.create({
      data: {
        borrowerId: id, fileName: file.filename.slice(0, 200), source,
        periodFrom: ymdToDbDate(s.periodFrom), periodTo: ymdToDbDate(s.periodTo),
        creditsTotal: D(s.creditsTotal), debitsTotal: D(s.debitsTotal), creditsCount: s.creditsCount,
        daysWithCredit: s.daysWithCredit, avgDailyCredits: D(s.avgDailyCredits), medianDaily: D(s.medianDaily),
        suggestedDaily: D(suggested), summary: s as unknown as Prisma.InputJsonValue,
      },
    });
    await audit(req, 'credit.statement.analyze', 'Borrower', id, { fileName: file.filename, credits: s.creditsTotal });
    return reply.code(201).send({ id: saved.id, summary: s, suggestedDaily: suggested });
  });

  // --------------------------------------------------------- simulação
  app.post('/api/credito/simular', async (req, reply) => {
    const body = z.object({
      borrowerId: uuid,
      principal: z.coerce.number().positive().max(100_000).optional(),
      installments: z.coerce.number().int().min(2).max(120).default(22),
      frequency: z.enum(['DAILY', 'WEEKLY']).default('DAILY'),
      firstDueDate: z.string().refine(isValidYmd).optional(),
      ratePercent: z.coerce.number().min(0).max(100).optional(),
    }).parse(req.body);

    const b = await prisma.borrower.findUnique({ where: { id: body.borrowerId }, include: { level: true, analyses: { orderBy: { createdAt: 'desc' }, take: 1 } } });
    if (!b) return reply.code(404).send({ error: 'not_found', message: 'Cliente não encontrado' });

    const settings = await getSettings();
    const level = b.level ?? (await prisma.creditLevel.findFirst({ where: { rank: 1 } }));
    const rate = body.ratePercent ?? num(level?.ratePercent ?? D(20));
    const levelMax = Math.min(num(level?.maxPrincipal ?? D(200)), settings.maxPrincipalGlobal);

    const capacity = estimateCapacity({
      segment: b.segment, openDaysPerWeek: b.openDaysPerWeek, businessMonths: b.businessMonths,
      declaredDailySales: b.declaredDailySales ? num(b.declaredDailySales) : null,
      statementDailyAverage: b.analyses[0] ? num(b.analyses[0].medianDaily) : null,
      ownsPoint: b.ownsPoint, referred: Boolean(b.referredBy),
    });

    const suggestion = suggestPrincipal({ capacity, frequency: body.frequency, installments: body.installments, ratePercent: rate, levelMax });

    // Regra da casa: além da capacidade do cliente, respeita caixa e concentração.
    const retrato = await retratoDaOperacao();
    const jaComEle = await prisma.creditContract.aggregate({
      _sum: { outstanding: true },
      where: { borrowerId: b.id, status: { in: ['ACTIVE', 'DEFAULTED'] } },
    });
    const limite = limiteParaCliente({
      capacidadeCliente: suggestion.principal || levelMax,
      tetoDoNivel: levelMax,
      patrimonio: retrato.caixa.patrimonio,
      jaEmprestadoAoCliente: num(jaComEle._sum.outstanding),
      disponivelParaEmprestar: retrato.caixa.disponivelParaEmprestar,
      padroes: retrato.padroes,
    });

    const principal = body.principal ?? limite.valorSugerido;
    if (principal <= 0) {
      return reply.code(422).send({ error: 'no_capacity', message: 'A capacidade estimada não cobre nenhum valor com esse prazo. Aumente o número de parcelas ou revise os dados do negócio.' });
    }

    const firstDue = body.firstDueDate ?? addDaysYmd(ymdSaoPaulo(), 1);
    const costs = computeCosts({
      principal, termDays: body.installments * (body.frequency === 'WEEKLY' ? 7 : 1),
      chargeIof: settings.chargeIof, iofFixedPercent: settings.iofFixedPercent, iofDailyPercent: settings.iofDailyPercent,
      tacFixed: settings.tacFixed, tacPercent: settings.tacPercent, otherCosts: settings.otherCosts, costsMode: settings.costsMode,
    });
    const q = buildQuote({ principal, ratePercent: rate, installments: body.installments, frequency: body.frequency, firstDueDate: firstDue, openDaysPerWeek: b.openDaysPerWeek, costs });

    const alerts: string[] = [...capacity.warnings];
    if (q.installmentAmount > (body.frequency === 'DAILY' ? capacity.dailyCapacity : capacity.weeklyCapacity)) {
      alerts.push(`A parcela de R$ ${q.installmentAmount.toFixed(2)} passa da capacidade estimada (R$ ${(body.frequency === 'DAILY' ? capacity.dailyCapacity : capacity.weeklyCapacity).toFixed(2)}). Reduza o valor ou alongue o prazo.`);
    }
    if (principal > levelMax) alerts.push(`O valor passa do teto do ${level?.name ?? 'nível atual'} (R$ ${levelMax.toFixed(2)}).`);
    if (costs.total > 0 && costs.mode === 'DEDUZIR') {
      alerts.push(`Atenção ao explicar: o cliente contrata ${real(principal)} mas recebe ${real(costs.netToBorrower)} na conta, porque ${real(costs.total)} são custos e tributos.`);
    }

    if (!retrato.saude.podeCrescer) {
      alerts.unshift(`${retrato.saude.frases[0]} Se liberar mesmo assim, faça por sua conta e risco.`);
    }
    if (body.principal && body.principal > limite.valorSugerido && limite.valorSugerido > 0) {
      alerts.unshift(`O sistema recomenda no máximo ${limite.valorSugerido.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} para este cliente hoje: ${limite.motivo}`);
    }

    return {
      quote: q, capacity, suggestion, limite, caixa: retrato.caixa, saude: retrato.saude, modo: retrato.modo,
      level: level ? { id: level.id, rank: level.rank, name: level.name, maxPrincipal: money2(level.maxPrincipal), ratePercent: money2(level.ratePercent) } : null,
      alerts,
    };
  });

  // ---------------------------------------------------------- contratos
  app.post('/api/credito/contratos', async (req, reply) => {
    const body = quoteSchema.parse(req.body);
    const settings = await getSettings();
    if (!settings.pixKey) return reply.code(409).send({ error: 'missing_pix', message: 'Cadastre a chave Pix da empresa em Configurações antes de gerar contratos.' });

    const b = await prisma.borrower.findUnique({ where: { id: body.borrowerId }, include: { level: true } });
    if (!b) return reply.code(404).send({ error: 'not_found', message: 'Cliente não encontrado' });

    const rule = canLendTo(b.personType, settings.regime);
    if (!rule.allowed) return reply.code(409).send({ error: 'regime_blocked', message: rule.reason });

    const open = await prisma.creditContract.findFirst({ where: { borrowerId: b.id, status: { in: ['DRAFT', 'AWAITING_SIGNATURE', 'SIGNED', 'ACTIVE'] } } });
    if (open) return reply.code(409).send({ error: 'open_contract', message: `Este cliente já tem o contrato ${open.number} em aberto (${open.status}).` });

    const level = body.levelId ? await prisma.creditLevel.findUnique({ where: { id: body.levelId } }) : b.level;
    const rate = body.ratePercent ?? num(level?.ratePercent ?? D(20));
    const levelMax = Math.min(num(level?.maxPrincipal ?? D(200)), settings.maxPrincipalGlobal);
    if (body.principal > levelMax) {
      return reply.code(422).send({ error: 'above_level', message: `O valor passa do teto do nível do cliente (R$ ${levelMax.toFixed(2)}). Suba o cliente de nível ou reduza o valor.` });
    }
    if (body.principal < settings.minPrincipal) {
      return reply.code(422).send({ error: 'below_min', message: `O valor mínimo configurado é R$ ${settings.minPrincipal.toFixed(2)}.` });
    }

    const costs = computeCosts({
      principal: body.principal, termDays: body.installments * (body.frequency === 'WEEKLY' ? 7 : 1),
      chargeIof: settings.chargeIof, iofFixedPercent: settings.iofFixedPercent, iofDailyPercent: settings.iofDailyPercent,
      tacFixed: settings.tacFixed, tacPercent: settings.tacPercent, otherCosts: settings.otherCosts, costsMode: settings.costsMode,
    });
    if (costs.netToBorrower <= 0) {
      return reply.code(422).send({ error: 'costs_exceed', message: 'Os custos configurados consomem todo o valor do contrato. Revise as tarifas em Configurações.' });
    }
    // Trava de caixa e concentração: evita emprestar o que vai fazer falta.
    const retrato = await retratoDaOperacao();
    const jaComEle = await prisma.creditContract.aggregate({
      _sum: { outstanding: true },
      where: { borrowerId: b.id, status: { in: ['ACTIVE', 'DEFAULTED'] } },
    });
    const limite = limiteParaCliente({
      capacidadeCliente: body.principal, tetoDoNivel: levelMax, patrimonio: retrato.caixa.patrimonio,
      jaEmprestadoAoCliente: num(jaComEle._sum.outstanding), disponivelParaEmprestar: retrato.caixa.disponivelParaEmprestar,
      padroes: retrato.padroes,
    });
    if (!body.ignorarLimite && body.principal > limite.valorSugerido) {
      return reply.code(422).send({
        error: 'limite_operacao',
        message: `${limite.motivo} Reduza o valor ou marque a opção de assumir o risco.`,
        sugerido: limite.valorSugerido,
        caixa: retrato.caixa,
      });
    }
    if (body.ignorarLimite && body.principal > limite.valorSugerido) {
      await audit(req, 'credit.limit.override', 'Borrower', b.id, { pedido: body.principal, sugerido: limite.valorSugerido, motivo: limite.motivo });
    }

    const q = buildQuote({ principal: body.principal, ratePercent: rate, installments: body.installments, frequency: body.frequency, firstDueDate: body.firstDueDate, openDaysPerWeek: b.openDaysPerWeek, costs });
    const number = await nextContractNumber();
    const issuedAt = new Date();

    const text = buildContractText({
      number,
      lender: { name: settings.companyName, document: settings.companyDocument, address: settings.companyAddress, pixKey: settings.pixKey, pixKeyLabel: settings.pixKeyLabel, regime: settings.regime, partnerName: settings.partnerName, legalReviewer: settings.legalReviewer, legalReviewerOab: settings.legalReviewerOab },
      borrower: {
        name: b.name, personType: b.personType, document: b.document, tradeName: b.tradeName,
        address: [b.addressStreet, b.addressNumber, b.addressDistrict, `${b.addressCity}/${b.addressState}`, b.addressZip].filter(Boolean).join(', '),
        whatsapp: b.whatsapp, segmentLabel: getSegment(b.segment).label,
      },
      quote: q,
      lateFeePercent: settings.lateFeePercent,
      lateDailyPercent: settings.lateDailyPercent,
      purpose: body.purpose,
      issuedAt,
    });

    const token = randomBytes(32).toString('base64url');
    const contract = await prisma.creditContract.create({
      data: {
        number, borrowerId: b.id, levelId: level?.id ?? null,
        principal: D(q.principal), ratePercent: D(rate), totalPayable: D(q.totalPayable),
        frequency: body.frequency, installmentsCount: q.installments, installmentAmount: D(q.installmentAmount),
        firstDueDate: ymdToDbDate(q.firstDueDate), businessDaysOnly: b.openDaysPerWeek <= 6,
        lateFeePercent: D(settings.lateFeePercent), lateDailyPercent: D(settings.lateDailyPercent),
        cetMonthly: D(q.cetMonthly), purpose: body.purpose ?? null,
        netToBorrower: D(q.netToBorrower), costsTotal: D(costs.total), costsBreakdown: costs as unknown as Prisma.InputJsonValue,
        status: 'AWAITING_SIGNATURE', outstanding: D(q.totalPayable),
        contractText: text, contractHash: hashContract(text),
        payToPixKey: settings.pixKey, createdById: req.operator!.id,
        signature: {
          create: { token, expiresAt: new Date(Date.now() + settings.signatureTtlHours * 3600_000) },
        },
      },
    });

    const link = `${env.APP_PUBLIC_URL}/assinatura.html?t=${token}`;
    const message = buildMessage('PROPOSTA', { firstName: b.name.split(' ')[0] ?? b.name, contractNumber: number, link });
    await audit(req, 'credit.contract.create', 'CreditContract', contract.id, { number, principal: q.principal, installments: q.installments });

    return reply.code(201).send({
      id: contract.id, number, link, whatsappLink: waLink(b.whatsapp, message), message,
      hash: shortHash(contract.contractHash), quote: q,
    });
  });

  app.get('/api/credito/contratos', async (req) => {
    const { status } = z.object({ status: z.string().optional() }).parse(req.query);
    const list = await prisma.creditContract.findMany({
      where: status ? { status: status as never } : {},
      include: { borrower: { select: { id: true, name: true, tradeName: true, whatsapp: true } }, installments: { select: { status: true } }, signature: { select: { acceptedAt: true, expiresAt: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    return list.map((c) => ({
      id: c.id, number: c.number, status: c.status,
      borrower: c.borrower, principal: money2(c.principal), totalPayable: money2(c.totalPayable),
      outstanding: money2(c.outstanding), installmentAmount: money2(c.installmentAmount),
      installmentsCount: c.installmentsCount, frequency: c.frequency,
      paid: c.installments.filter((i) => i.status === 'PAID').length,
      overdue: c.installments.filter((i) => i.status === 'OVERDUE').length,
      signedAt: c.signedAt, disbursedAt: c.disbursedAt, createdAt: c.createdAt,
      signatureExpiresAt: c.signature?.expiresAt ?? null,
    }));
  });

  app.get('/api/credito/contratos/:id', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const c = await prisma.creditContract.findUnique({
      where: { id },
      include: {
        borrower: true,
        installments: { orderBy: { sequence: 'asc' }, include: { payments: true } },
        signature: true,
        documents: { select: { id: true, kind: true, mimeType: true, sizeBytes: true, createdAt: true } },
      },
    });
    if (!c) return reply.code(404).send({ error: 'not_found', message: 'Contrato não encontrado' });

    return {
      id: c.id, number: c.number, status: c.status, contractText: c.contractText,
      hash: shortHash(c.contractHash), fullHash: c.contractHash,
      principal: money2(c.principal), ratePercent: money2(c.ratePercent), totalPayable: money2(c.totalPayable),
      outstanding: money2(c.outstanding), installmentAmount: money2(c.installmentAmount),
      installmentsCount: c.installmentsCount, frequency: c.frequency, cetMonthly: Number(c.cetMonthly),
      netToBorrower: money2(c.netToBorrower), costsTotal: money2(c.costsTotal), costsBreakdown: c.costsBreakdown,
      firstDueDate: dbDateToYmd(c.firstDueDate), purpose: c.purpose,
      receivePixKey: c.receivePixKey, payToPixKey: c.payToPixKey,
      signedAt: c.signedAt, disbursedAt: c.disbursedAt, paidAt: c.paidAt, createdAt: c.createdAt,
      borrower: {
        id: c.borrower.id, name: c.borrower.name, tradeName: c.borrower.tradeName, document: c.borrower.document,
        personType: c.borrower.personType, whatsapp: c.borrower.whatsapp, city: `${c.borrower.addressCity}/${c.borrower.addressState}`,
      },
      signature: c.signature ? {
        acceptedAt: c.signature.acceptedAt, expiresAt: c.signature.expiresAt, openedAt: c.signature.openedAt,
        signerName: c.signature.signerName, signerDocument: c.signature.signerDocument, signerIp: c.signature.signerIp,
        signerUserAgent: c.signature.signerUserAgent, typedSignature: c.signature.typedSignature,
        signerPixKey: c.signature.signerPixKey, signerPixKeyType: c.signature.signerPixKeyType,
        link: c.signature.acceptedAt ? null : `${env.APP_PUBLIC_URL}/assinatura.html?t=${c.signature.token}`,
      } : null,
      documents: c.documents,
      installments: c.installments.map((i) => ({
        id: i.id, sequence: i.sequence, dueDate: dbDateToYmd(i.dueDate), amountDue: money2(i.amountDue),
        amountPaid: money2(i.amountPaid), lateCharge: money2(i.lateCharge), status: i.status, paidAt: i.paidAt,
        payments: i.payments.map((p) => ({ id: p.id, amount: money2(p.amount), paidAt: p.paidAt, method: p.method, note: p.note })),
      })),
    };
  });

  /** Gera um link novo (o anterior deixa de valer). */
  app.post('/api/credito/contratos/:id/reenviar', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const c = await prisma.creditContract.findUnique({ where: { id }, include: { borrower: true, signature: true } });
    if (!c) return reply.code(404).send({ error: 'not_found', message: 'Contrato não encontrado' });
    if (c.status !== 'AWAITING_SIGNATURE') return reply.code(409).send({ error: 'not_pending', message: 'Este contrato não está aguardando assinatura.' });

    const settings = await getSettings();
    const token = randomBytes(32).toString('base64url');
    await prisma.contractSignature.update({
      where: { contractId: id },
      data: { token, expiresAt: new Date(Date.now() + settings.signatureTtlHours * 3600_000), openedAt: null },
    });
    const link = `${env.APP_PUBLIC_URL}/assinatura.html?t=${token}`;
    const message = buildMessage('PROPOSTA', { firstName: c.borrower.name.split(' ')[0] ?? c.borrower.name, contractNumber: c.number, link });
    await audit(req, 'credit.contract.resend', 'CreditContract', id, {});
    return { link, whatsappLink: waLink(c.borrower.whatsapp, message), message };
  });

  /** Liberação do dinheiro: cria as parcelas e coloca o contrato para correr. */
  app.post('/api/credito/contratos/:id/liberar', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({ proof: z.string().trim().max(200).optional(), firstDueDate: z.string().refine(isValidYmd).optional() }).parse(req.body ?? {});

    const c = await prisma.creditContract.findUnique({ where: { id }, include: { borrower: true, signature: true } });
    if (!c) return reply.code(404).send({ error: 'not_found', message: 'Contrato não encontrado' });
    if (c.status !== 'SIGNED') return reply.code(409).send({ error: 'not_signed', message: 'O contrato só pode ser liberado depois que o cliente assinar.' });

    const tomorrow = addDaysYmd(ymdSaoPaulo(), 1);
    const stored = dbDateToYmd(c.firstDueDate);
    const firstDue = body.firstDueDate ?? (stored < tomorrow ? tomorrow : stored);
    const q = buildQuote({
      principal: num(c.principal), ratePercent: num(c.ratePercent), installments: c.installmentsCount,
      frequency: c.frequency, firstDueDate: firstDue, openDaysPerWeek: c.borrower.openDaysPerWeek,
    });

    await prisma.$transaction(async (tx) => {
      await tx.creditInstallment.createMany({
        data: q.dueDates.map((d, idx) => ({ contractId: id, sequence: idx + 1, dueDate: ymdToDbDate(d), amountDue: D(q.amounts[idx]!) })),
      });
      await tx.creditContract.update({
        where: { id },
        data: { status: 'ACTIVE', disbursedAt: new Date(), disbursedProof: body.proof ?? null, firstDueDate: ymdToDbDate(q.firstDueDate), outstanding: D(q.totalPayable) },
      });
      await tx.borrower.update({ where: { id: c.borrowerId }, data: { status: 'ATIVO' } });
      // Saiu dinheiro do caixa: registra o valor que foi de fato para o cliente.
      await tx.cashEntry.create({
        data: {
          kind: 'LIBERACAO', amount: D(-(num(c.netToBorrower) > 0 ? num(c.netToBorrower) : num(c.principal))),
          happenedAt: new Date(), description: `Liberação do contrato ${c.number} — ${c.borrower.name}`,
          contractId: c.id, borrowerId: c.borrowerId, operatorId: req.operator!.id,
        },
      });
      await tx.creditNotification.create({
        data: {
          borrowerId: c.borrowerId, contractId: id, kind: 'BOAS_VINDAS', referenceDate: ymdToDbDate(ymdSaoPaulo()),
          message: buildMessage('BOAS_VINDAS', {
            firstName: c.borrower.name.split(' ')[0] ?? c.borrower.name, contractNumber: c.number,
            installmentSeq: 1, installmentsCount: c.installmentsCount, amount: q.amounts[0], dueDate: q.firstDueDate,
            pixKey: c.payToPixKey, pixOwner: (await getSettings()).pixOwner,
          }),
        },
      });
    });

    await audit(req, 'credit.contract.disburse', 'CreditContract', id, { firstDue: q.firstDueDate, proof: body.proof ?? null });
    return { ok: true, firstDueDate: q.firstDueDate, installments: q.installments };
  });

  app.post('/api/credito/contratos/:id/cancelar', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const { reason } = z.object({ reason: z.string().trim().min(3).max(300) }).parse(req.body);
    const r = await prisma.creditContract.updateMany({ where: { id, status: { in: ['DRAFT', 'AWAITING_SIGNATURE', 'SIGNED'] } }, data: { status: 'CANCELLED' } });
    if (r.count !== 1) return reply.code(409).send({ error: 'cannot_cancel', message: 'Só dá para cancelar contratos que ainda não foram liberados.' });
    await audit(req, 'credit.contract.cancel', 'CreditContract', id, { reason });
    return { ok: true };
  });

  // ------------------------------------------------------------- baixas
  app.post('/api/credito/parcelas/:id/baixa', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const body = z.object({
      amount: z.coerce.number().positive().max(100_000).optional(),
      paidAt: z.string().refine(isValidYmd).optional(),
      method: z.enum(['PIX', 'DINHEIRO', 'TRANSFERENCIA', 'OUTRO']).default('PIX'),
      receiptRef: z.string().trim().max(120).optional(),
      note: z.string().trim().max(300).optional(),
    }).parse(req.body ?? {});

    const inst = await prisma.creditInstallment.findUnique({ where: { id }, include: { contract: { include: { borrower: true, installments: true } } } });
    if (!inst) return reply.code(404).send({ error: 'not_found', message: 'Parcela não encontrada' });
    if (inst.contract.status !== 'ACTIVE') return reply.code(409).send({ error: 'contract_not_active', message: 'O contrato não está ativo.' });
    if (inst.status === 'PAID') return reply.code(409).send({ error: 'already_paid', message: 'Esta parcela já está baixada.' });

    const remaining = inst.amountDue.plus(inst.lateCharge).minus(inst.amountPaid);
    const amount = D(body.amount ?? Number(remaining.toFixed(2)));
    const paidAt = body.paidAt ? new Date(`${body.paidAt}T12:00:00.000-03:00`) : new Date();

    const result = await prisma.$transaction(async (tx) => {
      await tx.creditPayment.create({
        data: { installmentId: id, amount, paidAt, method: body.method, receiptRef: body.receiptRef ?? null, note: body.note ?? null, operatorId: req.operator!.id },
      });
      const newPaid = inst.amountPaid.plus(amount);
      const target = inst.amountDue.plus(inst.lateCharge);
      const settled = newPaid.greaterThanOrEqualTo(target.minus(0.01));
      await tx.creditInstallment.update({
        where: { id },
        data: { amountPaid: newPaid, status: settled ? 'PAID' : 'PARTIAL', paidAt: settled ? paidAt : null },
      });

      // Entrou dinheiro no caixa.
      await tx.cashEntry.create({
        data: {
          kind: 'RECEBIMENTO', amount, happenedAt: paidAt,
          description: `Parcela ${inst.sequence} do contrato ${inst.contract.number} — ${inst.contract.borrower.name}`,
          contractId: inst.contractId, borrowerId: inst.contract.borrowerId, operatorId: req.operator!.id,
        },
      });

      const contract = await tx.creditContract.findUniqueOrThrow({ where: { id: inst.contractId }, include: { installments: true } });
      const outstanding = contract.installments.reduce((acc, i) => {
        const paid = i.id === id ? newPaid : i.amountPaid;
        const due = i.amountDue.plus(i.lateCharge);
        const left = due.minus(paid);
        return acc.plus(left.greaterThan(0) ? left : D(0));
      }, D(0));

      const finished = outstanding.lessThanOrEqualTo(0.01);
      await tx.creditContract.update({
        where: { id: contract.id },
        data: { outstanding: finished ? D(0) : outstanding.toDecimalPlaces(2), status: finished ? 'PAID' : contract.status, paidAt: finished ? new Date() : null },
      });

      let levelUp: string | null = null;
      if (finished) {
        // Quitou: sobe um nível se o contrato não teve mais de 2 parcelas atrasadas.
        const lateCount = contract.installments.filter((i) => Number(i.lateCharge) > 0).length;
        const borrower = await tx.borrower.findUniqueOrThrow({ where: { id: contract.borrowerId }, include: { level: true } });
        const nextRank = (borrower.level?.rank ?? 1) + 1;
        const next = lateCount <= 2 ? await tx.creditLevel.findFirst({ where: { rank: nextRank, active: true } }) : null;
        await tx.borrower.update({
          where: { id: borrower.id },
          data: { status: 'EM_DIA', cyclesPaid: { increment: 1 }, ...(next ? { levelId: next.id } : {}) },
        });
        if (next) levelUp = next.name;

        await tx.creditNotification.create({
          data: {
            borrowerId: borrower.id, contractId: contract.id, kind: 'QUITACAO', referenceDate: ymdToDbDate(ymdSaoPaulo()),
            message: buildMessage('QUITACAO', { firstName: borrower.name.split(' ')[0] ?? borrower.name, contractNumber: contract.number }),
          },
        });
      }

      // Se a parcela ficou quitada, encerra qualquer aviso pendente dela.
      if (settled) {
        await tx.creditNotification.updateMany({ where: { installmentId: id, status: 'PENDENTE' }, data: { status: 'DISPENSADA' } });
      }
      return { settled, finished, levelUp, outstanding: finished ? '0.00' : outstanding.toFixed(2) };
    });

    await audit(req, 'credit.payment.register', 'CreditInstallment', id, { amount: amount.toFixed(2), method: body.method });
    return result;
  });

  // --------------------------------------------------------- cobranças
  app.get('/api/credito/cobrancas', async (req) => {
    const { date } = z.object({ date: z.string().refine(isValidYmd).optional() }).parse(req.query);
    const today = date ?? ymdSaoPaulo();
    const settings = await getSettings();

    const installments = await prisma.creditInstallment.findMany({
      where: { status: { in: ['PENDING', 'PARTIAL', 'OVERDUE'] }, dueDate: { lte: ymdToDbDate(today) }, contract: { status: 'ACTIVE' } },
      include: { contract: { include: { borrower: true } } },
      orderBy: [{ dueDate: 'asc' }],
      take: 500,
    });

    const rows = installments.map((i) => {
      const due = dbDateToYmd(i.dueDate);
      const lateDays = Math.max(0, Math.round((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${due}T12:00:00Z`)) / 86400_000));
      const charge = lateCharge(i.amountDue, lateDays, i.contract.lateFeePercent, i.contract.lateDailyPercent);
      const totalDue = Number(i.amountDue.plus(charge).minus(i.amountPaid).toFixed(2));
      const b = i.contract.borrower;
      const firstName = b.name.split(' ')[0] ?? b.name;
      const message = buildMessage(lateDays > 0 ? 'ATRASO' : 'LEMBRETE', {
        firstName, contractNumber: i.contract.number, installmentSeq: i.sequence, installmentsCount: i.contract.installmentsCount,
        amount: Number(i.amountDue), dueDate: due, lateDays, totalDue, pixKey: i.contract.payToPixKey, pixOwner: settings.pixOwner,
      });
      return {
        installmentId: i.id, contractId: i.contractId, contractNumber: i.contract.number,
        borrower: { id: b.id, name: b.name, tradeName: b.tradeName, whatsapp: b.whatsapp },
        sequence: i.sequence, installmentsCount: i.contract.installmentsCount,
        dueDate: due, amountDue: money2(i.amountDue), amountPaid: money2(i.amountPaid),
        lateDays, lateCharge: charge.toFixed(2), totalDue: totalDue.toFixed(2),
        status: lateDays > 0 ? 'ATRASADA' : 'HOJE',
        message, whatsappLink: waLink(b.whatsapp, message),
      };
    });

    const totals = {
      hoje: rows.filter((r) => r.status === 'HOJE').length,
      atrasadas: rows.filter((r) => r.status === 'ATRASADA').length,
      valorHoje: rows.filter((r) => r.status === 'HOJE').reduce((s, r) => s + Number(r.totalDue), 0).toFixed(2),
      valorAtrasado: rows.filter((r) => r.status === 'ATRASADA').reduce((s, r) => s + Number(r.totalDue), 0).toFixed(2),
    };
    return { date: today, totals, rows };
  });

  // ------------------------------------------------------------ painel
  app.get('/api/credito/painel', async () => {
    const today = ymdToDbDate(ymdSaoPaulo());
    const [borrowers, active, awaiting, overdueInst, dueToday, paidToday, carteira] = await Promise.all([
      prisma.borrower.count(),
      prisma.creditContract.count({ where: { status: 'ACTIVE' } }),
      prisma.creditContract.count({ where: { status: { in: ['AWAITING_SIGNATURE', 'SIGNED'] } } }),
      prisma.creditInstallment.count({ where: { status: 'OVERDUE', contract: { status: 'ACTIVE' } } }),
      prisma.creditInstallment.aggregate({ _sum: { amountDue: true }, where: { dueDate: today, status: { in: ['PENDING', 'PARTIAL'] } } }),
      prisma.creditPayment.aggregate({ _sum: { amount: true }, where: { paidAt: { gte: new Date(`${ymdSaoPaulo()}T00:00:00.000-03:00`) } } }),
      prisma.creditContract.aggregate({ _sum: { outstanding: true, principal: true }, where: { status: 'ACTIVE' } }),
    ]);

    return {
      borrowers, activeContracts: active, awaitingSignature: awaiting, overdueInstallments: overdueInst,
      dueToday: money2(dueToday._sum.amountDue) ?? '0.00',
      receivedToday: money2(paidToday._sum.amount) ?? '0.00',
      outstanding: money2(carteira._sum.outstanding) ?? '0.00',
      principalOut: money2(carteira._sum.principal) ?? '0.00',
    };
  });

  /**
   * VISÃO FINANCEIRA DA OPERAÇÃO
   *
   * Cada pagamento recebido é dividido entre principal e juros na mesma proporção
   * do contrato (regra pro-rata). Assim dá para responder, a qualquer momento:
   * quanto do meu dinheiro já voltou, quanto ainda está na rua e quanto virou lucro.
   */
  app.get('/api/credito/resumo', async (req) => {
    const q = z.object({
      from: z.string().refine(isValidYmd).optional(),
      to: z.string().refine(isValidYmd).optional(),
    }).parse(req.query);
    const to = q.to ?? ymdSaoPaulo();
    const from = q.from ?? addDaysYmd(to, -29);
    const ini = new Date(`${from}T00:00:00.000-03:00`);
    const fim = new Date(`${to}T23:59:59.999-03:00`);

    const contratos = await prisma.creditContract.findMany({
      where: { status: { in: ['ACTIVE', 'PAID', 'DEFAULTED'] } },
      include: { installments: { include: { payments: true } }, borrower: { select: { id: true, name: true, tradeName: true, whatsapp: true } } },
    });

    let liberadoTotal = 0, liberadoPeriodo = 0;
    let recebidoTotal = 0, recebidoPeriodo = 0;
    let principalRecuperado = 0, jurosRecebidos = 0, jurosPeriodo = 0;
    let aReceber = 0, jurosPrevistos = 0, emAtraso = 0, emRisco = 0;
    const porMes = new Map<string, { liberado: number; recebido: number; juros: number }>();
    const mes = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d).slice(0, 7);
    const bucket = (k: string) => porMes.get(k) ?? porMes.set(k, { liberado: 0, recebido: 0, juros: 0 }).get(k)!;

    const atrasados: Array<Record<string, string | number>> = [];

    for (const c of contratos) {
      const principal = num(c.principal);
      const total = num(c.totalPayable);
      const fatiaPrincipal = total > 0 ? principal / total : 1;

      if (c.disbursedAt) {
        liberadoTotal += principal;
        bucket(mes(c.disbursedAt)).liberado += principal;
        if (c.disbursedAt >= ini && c.disbursedAt <= fim) liberadoPeriodo += principal;
      }

      let pagoContrato = 0, atrasoContrato = 0, maxDiasAtraso = 0;
      for (const i of c.installments) {
        for (const p of i.payments) {
          const v = num(p.amount);
          pagoContrato += v;
          recebidoTotal += v;
          principalRecuperado += v * fatiaPrincipal;
          jurosRecebidos += v * (1 - fatiaPrincipal);
          const b = bucket(mes(p.paidAt));
          b.recebido += v;
          b.juros += v * (1 - fatiaPrincipal);
          if (p.paidAt >= ini && p.paidAt <= fim) { recebidoPeriodo += v; jurosPeriodo += v * (1 - fatiaPrincipal); }
        }
        if (i.status === 'OVERDUE') {
          const falta = num(i.amountDue) + num(i.lateCharge) - num(i.amountPaid);
          atrasoContrato += Math.max(0, falta);
          const dias = Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${dbDateToYmd(i.dueDate)}T12:00:00Z`)) / 86400_000);
          maxDiasAtraso = Math.max(maxDiasAtraso, dias);
        }
      }

      if (c.status === 'ACTIVE' || c.status === 'DEFAULTED') {
        aReceber += num(c.outstanding);
        jurosPrevistos += Math.max(0, total - principal - (pagoContrato * (1 - fatiaPrincipal)));
        emAtraso += atrasoContrato;
        if (c.status === 'DEFAULTED') emRisco += num(c.outstanding);
      }
      if (atrasoContrato > 0) {
        atrasados.push({
          contractId: c.id, number: c.number, cliente: c.borrower.tradeName ?? c.borrower.name,
          whatsapp: c.borrower.whatsapp, valor: atrasoContrato.toFixed(2), dias: maxDiasAtraso,
        });
      }
    }

    const r2 = (n: number) => Math.round(n * 100) / 100;
    const capitalNaRua = r2(liberadoTotal - principalRecuperado);
    const meses = [...porMes.entries()].sort(([a], [b]) => a.localeCompare(b)).slice(-6)
      .map(([m, v]) => ({ mes: m, liberado: r2(v.liberado), recebido: r2(v.recebido), juros: r2(v.juros) }));

    return {
      periodo: { from, to },
      capital: {
        liberadoTotal: r2(liberadoTotal),
        principalRecuperado: r2(principalRecuperado),
        capitalNaRua,
        percentualRecuperado: liberadoTotal > 0 ? r2((principalRecuperado / liberadoTotal) * 100) : 0,
      },
      resultado: {
        jurosRecebidos: r2(jurosRecebidos),
        jurosPrevistos: r2(jurosPrevistos),
        recebidoTotal: r2(recebidoTotal),
        retornoSobreCapital: liberadoTotal > 0 ? r2((jurosRecebidos / liberadoTotal) * 100) : 0,
      },
      periodoValores: { liberado: r2(liberadoPeriodo), recebido: r2(recebidoPeriodo), juros: r2(jurosPeriodo) },
      carteira: {
        aReceber: r2(aReceber),
        emAtraso: r2(emAtraso),
        emRisco: r2(emRisco),
        inadimplencia: aReceber > 0 ? r2((emAtraso / aReceber) * 100) : 0,
      },
      meses,
      atrasados: atrasados.sort((a, b) => Number(b.dias) - Number(a.dias)).slice(0, 10),
    };
  });

  // ----------------------------------------------------------------- caixa
  /** Painel do gestor: caixa, saúde da carteira, projeção e o que fazer hoje. */
  app.get('/api/credito/gestor', async () => {
    const r = await retratoDaOperacao();
    return {
      caixa: r.caixa,
      saude: r.saude,
      tarefas: r.tarefas,
      projecao: { ...r.projecao, linha: r.projecao.linha.slice(0, 30) },
      carteira: { principalNaRua: r.principalNaRua.toFixed(2), aReceber: r.carteiraTotal.toFixed(2), clientesAtivos: r.clientesAtivos, parcelasAtrasadas: r.parcelasAtrasadas },
      modo: r.modo,
      padroes: r.padroes,
    };
  });

  /** Livro-caixa: extrato de tudo que entrou e saiu. */
  app.get('/api/credito/caixa', async (req) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(200).default(60) }).parse(req.query);
    const [entradas, saldo, porTipo] = await Promise.all([
      prisma.cashEntry.findMany({ orderBy: [{ happenedAt: 'desc' }, { createdAt: 'desc' }], take: limit }),
      saldoDoCaixa(),
      prisma.cashEntry.groupBy({ by: ['kind'], _sum: { amount: true } }),
    ]);
    const retrato = await retratoDaOperacao();
    return {
      saldo: saldo.toFixed(2),
      situacao: retrato.caixa,
      totais: Object.fromEntries(porTipo.map((t) => [t.kind, money2(t._sum.amount) ?? '0.00'])),
      lancamentos: entradas.map((e) => ({
        id: e.id, kind: e.kind, amount: money2(e.amount), happenedAt: e.happenedAt,
        description: e.description, contractId: e.contractId,
      })),
    };
  });

  /** Aporte, retirada ou despesa, lançados à mão. */
  app.post('/api/credito/caixa', async (req) => {
    const body = z.object({
      kind: z.enum(['APORTE', 'RETIRADA', 'DESPESA', 'AJUSTE']),
      amount: z.coerce.number().positive().max(10_000_000),
      description: z.string().trim().min(3).max(200),
      happenedAt: z.string().refine(isValidYmd).optional(),
    }).parse(req.body);

    const sinal = body.kind === 'APORTE' ? 1 : body.kind === 'AJUSTE' ? 1 : -1;
    const entrada = await prisma.cashEntry.create({
      data: {
        kind: body.kind, amount: D(body.amount * sinal), description: body.description,
        happenedAt: body.happenedAt ? new Date(`${body.happenedAt}T12:00:00.000-03:00`) : new Date(),
        operatorId: req.operator!.id,
      },
    });
    await audit(req, `cash.${body.kind.toLowerCase()}`, 'CashEntry', entrada.id, { amount: body.amount, description: body.description });
    return { ok: true, saldo: (await saldoDoCaixa()).toFixed(2) };
  });

  /** Arquivo enviado pelo cliente (documento/selfie/comprovante). */
  app.get('/api/credito/documentos/:id', async (req, reply) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    const doc = await prisma.borrowerDocument.findUnique({ where: { id } });
    if (!doc) return reply.code(404).send({ error: 'not_found' });
    return reply.header('Content-Type', doc.mimeType).header('Cache-Control', 'private, max-age=60').send(Buffer.from(doc.data));
  });

  app.post('/api/credito/notificacoes/:id/enviada', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    await prisma.creditNotification.update({ where: { id }, data: { status: 'ENVIADA', sentAt: new Date(), operatorId: req.operator!.id } });
    return { ok: true };
  });

  app.get('/api/credito/notificacoes', async () => {
    const list = await prisma.creditNotification.findMany({
      where: { status: 'PENDENTE' },
      include: { borrower: { select: { name: true, whatsapp: true } } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return list.map((n) => ({
      id: n.id, kind: n.kind, message: n.message, createdAt: n.createdAt,
      borrower: n.borrower, whatsappLink: waLink(n.borrower.whatsapp, n.message),
    }));
  });
}

export { MAX_UPLOAD, IMAGE_TYPES };
