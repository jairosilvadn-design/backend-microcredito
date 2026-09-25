import { prisma } from '../../lib/prisma';

/** Configurações da operação, editáveis no painel (sem mexer em código). */
export interface OperationSettings {
  companyName: string;
  companyDocument: string;
  companyAddress: string;
  pixKey: string;
  pixKeyLabel: string;      // "CNPJ", "Celular", "Chave aleatória"...
  pixOwner: string;
  regime: 'ESC' | 'SCD' | 'PARCEIRO_SCD';
  partnerName?: string;
  lateFeePercent: number;   // CDC: máximo 2%
  lateDailyPercent: number; // ~1% ao mês
  signatureTtlHours: number;
  maxPrincipalGlobal: number;
  minPrincipal: number;

  // Custos da operação (como nos bancos: IOF + tarifas, tudo declarado no contrato)
  chargeIof: boolean;
  iofFixedPercent: number;   // alíquota adicional, incide sobre o principal
  iofDailyPercent: number;   // por dia de prazo, limitada a 365 dias
  tacFixed: number;          // tarifa de cadastro em R$
  tacPercent: number;        // ou um % do valor contratado
  otherCosts: number;        // registro, cartório, etc.
  costsMode: 'DEDUZIR' | 'FINANCIAR'; // descontar do valor entregue ou somar ao total

  // Responsável técnico (aparece no contrato só se preenchido)
  legalReviewer?: string;    // nome do advogado/escritório
  legalReviewerOab?: string; // OAB
}

export const DEFAULT_SETTINGS: OperationSettings = {
  companyName: 'Impulsa Comércio',
  companyDocument: '',
  companyAddress: '',
  pixKey: '',
  pixKeyLabel: 'CNPJ',
  pixOwner: '',
  regime: 'ESC',
  lateFeePercent: 2,
  lateDailyPercent: 0.033,
  signatureTtlHours: 72,
  maxPrincipalGlobal: 500,
  minPrincipal: 100,
  chargeIof: false,
  iofFixedPercent: 0.38,
  iofDailyPercent: 0.0082,
  tacFixed: 0,
  tacPercent: 0,
  otherCosts: 0,
  costsMode: 'DEDUZIR',
};

const KEY = 'operation';

export async function getSettings(): Promise<OperationSettings> {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
  return { ...DEFAULT_SETTINGS, ...((row?.value as Partial<OperationSettings>) ?? {}) };
}

export async function saveSettings(patch: Partial<OperationSettings>): Promise<OperationSettings> {
  const merged = { ...(await getSettings()), ...patch };
  await prisma.appSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: merged as object },
    update: { value: merged as object },
  });
  return merged;
}

/** Níveis padrão da escada de limites, criados na primeira execução. */
export const DEFAULT_LEVELS = [
  { rank: 1, name: 'Nível 1 — Início', maxPrincipal: 200, ratePercent: 20, maxTerm: 22 },
  { rank: 2, name: 'Nível 2 — Confiança', maxPrincipal: 300, ratePercent: 18, maxTerm: 24 },
  { rank: 3, name: 'Nível 3 — Parceiro', maxPrincipal: 400, ratePercent: 16, maxTerm: 26 },
  { rank: 4, name: 'Nível 4 — Preferencial', maxPrincipal: 500, ratePercent: 15, maxTerm: 30 },
];

export async function ensureLevels() {
  const count = await prisma.creditLevel.count();
  if (count > 0) return;
  await prisma.creditLevel.createMany({ data: DEFAULT_LEVELS });
}

/** Regra de regime: como ESC, só PJ (MEI/ME/EPP). PF exige SCD ou parceria. */
export function canLendTo(personType: 'PF' | 'PJ', regime: OperationSettings['regime']): { allowed: boolean; reason?: string } {
  if (personType === 'PJ') return { allowed: true };
  if (regime === 'ESC') {
    return {
      allowed: false,
      reason: 'No regime ESC só é permitido emprestar a MEI, ME e EPP (CNPJ). Para atender CPF, mude o regime em Configurações para SCD ou Parceria com SCD — e só faça isso quando a estrutura jurídica estiver formalizada.',
    };
  }
  return { allowed: true };
}
