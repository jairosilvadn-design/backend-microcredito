import { createHash } from 'node:crypto';
import type { Quote } from './pricing.service';

/**
 * Texto do contrato (mútuo com pagamento parcelado) congelado no envio.
 * O que o cliente assina é exatamente este texto, e o hash SHA-256 dele fica
 * guardado junto com IP, data/hora e documentos — é a prova do aceite.
 *
 * ATENÇÃO JURÍDICA: este é um modelo operacional, não um parecer. Antes de usar
 * em produção, o texto deve ser revisado por advogado, inclusive quanto ao
 * regime da operação (ESC só pode emprestar a MEI/ME/EPP; pessoa física exige
 * SCD própria ou parceria com uma).
 */

export interface LenderInfo {
  name: string;
  document: string;
  address: string;
  pixKey: string;
  pixKeyLabel: string;
  regime: 'ESC' | 'SCD' | 'PARCEIRO_SCD';
  partnerName?: string;
  legalReviewer?: string;
  legalReviewerOab?: string;
}

export interface BorrowerInfo {
  name: string;
  personType: 'PF' | 'PJ';
  document: string;
  tradeName?: string | null;
  address: string;
  whatsapp: string;
  segmentLabel: string;
}

const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Linhas de custo dentro do quadro de condições. */
function custosBloco(q: Quote): string {
  if (!q.costs || q.costs.total === 0) return `   Valor líquido entregue ........... ${brl(q.netToBorrower)}`;
  return `   Custos e tributos (item 4) ....... ${brl(q.costs.total)}
   Valor líquido entregue ........... ${brl(q.netToBorrower)}`;
}

/** Demonstrativo de custos, no formato usado em contratos bancários. */
function demonstrativo(q: Quote): string {
  if (!q.costs || q.costs.total === 0) {
    return `Esta operação não possui tarifas nem tributos adicionais. O valor entregue ao DEVEDOR é de ${brl(q.netToBorrower)}, igual ao valor contratado.`;
  }
  const linhas = q.costs.lines
    .map((l) => `   ${l.label.padEnd(58, '.')} ${brl(l.value)}`)
    .join('\n');
  const modo = q.costs.mode === 'DEDUZIR'
    ? 'Os custos abaixo são descontados no ato da liberação: o DEVEDOR recebe o valor líquido e devolve as parcelas do item 3.'
    : 'Os custos abaixo são acrescidos ao saldo devedor: o DEVEDOR recebe o valor contratado e devolve o total com os custos diluídos nas parcelas.';
  return `${modo}

${linhas}`;
}

function revisor(l: LenderInfo): string {
  if (!l.legalReviewer) return '';
  return `
12. RESPONSÁVEL TÉCNICO

Minuta revisada por ${l.legalReviewer}${l.legalReviewerOab ? `, OAB nº ${l.legalReviewerOab}` : ''}.
`;
}
const dateBr = (ymd: string) => ymd.split('-').reverse().join('/');

export function buildContractText(params: {
  number: string;
  lender: LenderInfo;
  borrower: BorrowerInfo;
  quote: Quote;
  lateFeePercent: number;
  lateDailyPercent: number;
  purpose?: string | null;
  issuedAt: Date;
}): string {
  const { lender, borrower, quote: q } = params;
  const freq = q.frequency === 'DAILY' ? 'diárias' : 'semanais';
  const freqSing = q.frequency === 'DAILY' ? 'diária' : 'semanal';

  const parcelas = q.dueDates
    .map((d, i) => `   ${String(i + 1).padStart(2, '0')}) ${dateBr(d)} — ${brl(q.amounts[i]!)}`)
    .join('\n');

  const credorLinha = lender.regime === 'PARCEIRO_SCD' && lender.partnerName
    ? `${lender.partnerName}, instituição financeira autorizada pelo Banco Central, tendo ${lender.name} (CNPJ ${lender.document}) como correspondente/originadora`
    : `${lender.name}, inscrita no CNPJ sob o nº ${lender.document}, com endereço em ${lender.address}`;

  return `CONTRATO DE EMPRÉSTIMO COM PAGAMENTO PARCELADO
Contrato nº ${params.number}
Emitido em ${params.issuedAt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}

1. PARTES

CREDORA: ${credorLinha}.

DEVEDOR(A): ${borrower.name}${borrower.tradeName ? ` (nome fantasia: ${borrower.tradeName})` : ''}, ${borrower.personType === 'PJ' ? 'CNPJ' : 'CPF'} nº ${borrower.document}, endereço ${borrower.address}, WhatsApp ${borrower.whatsapp}, atuante no ramo de ${borrower.segmentLabel}.

2. OBJETO

A CREDORA concede ao DEVEDOR crédito no valor contratado de ${brl(q.principal)}, com entrega líquida de ${brl(q.netToBorrower)} (item 4), a ser devolvido em ${q.installments} parcelas ${freq}, conforme o quadro do item 3.${params.purpose ? ` Finalidade declarada: ${params.purpose}.` : ''}

3. CONDIÇÕES FINANCEIRAS

   Valor contratado .................. ${brl(q.principal)}
   Encargo do período ............... ${q.ratePercent}% sobre o valor liberado
   Total a devolver ................. ${brl(q.totalPayable)}
   Quantidade de parcelas ........... ${q.installments} (${freq})
   Valor de cada parcela ............ ${brl(q.installmentAmount)}${q.lastInstallmentAmount !== q.installmentAmount ? ` (a última: ${brl(q.lastInstallmentAmount)})` : ''}
   Primeiro vencimento .............. ${dateBr(q.firstDueDate)}
   Último vencimento ................ ${dateBr(q.lastDueDate)}
   Custo Efetivo Total (CET) ........ ${q.cetLabel}
${custosBloco(q)}

   Quadro de vencimentos:
${parcelas}

4. CUSTOS DA OPERAÇÃO E VALOR LÍQUIDO

${demonstrativo(q)}
O DEVEDOR declara ciência de que o Custo Efetivo Total informado no item 3 já considera todos os encargos e tarifas acima, calculado sobre o valor efetivamente entregue.

5. FORMA DE PAGAMENTO

As parcelas serão pagas por Pix para a chave ${lender.pixKey} (${lender.pixKeyLabel}), até as 20h do dia do vencimento. O comprovante deve ser enviado pelo WhatsApp. Cada parcela recebida é registrada no sistema da CREDORA, e o DEVEDOR pode solicitar o extrato do contrato a qualquer momento.

6. LIBERAÇÃO DO VALOR

O valor líquido de ${brl(q.netToBorrower)} será transferido por Pix para a chave informada pelo DEVEDOR no ato da assinatura, de titularidade do próprio DEVEDOR. A CREDORA não libera valores para chave de terceiros.

7. ATRASO

Em caso de atraso incidem multa de ${params.lateFeePercent}% sobre a parcela e juros de mora de ${params.lateDailyPercent}% ao dia, contados do vencimento até o pagamento. O atraso superior a 5 (cinco) dias autoriza a CREDORA a considerar vencidas todas as parcelas seguintes e a cobrar o saldo integral, além de registrar a dívida nos órgãos de proteção ao crédito, sempre mediante aviso prévio ao DEVEDOR.

8. QUITAÇÃO ANTECIPADA

O DEVEDOR pode quitar o contrato a qualquer momento, com redução proporcional dos encargos ainda não vencidos, conforme o artigo 52, §2º, do Código de Defesa do Consumidor.

9. DADOS PESSOAIS (LGPD)

O DEVEDOR autoriza a CREDORA a tratar seus dados pessoais e documentos (documento de identidade, selfie de conferência e comprovante de endereço) exclusivamente para análise de crédito, formalização e cobrança deste contrato, pelo prazo legal de guarda. O DEVEDOR pode solicitar acesso, correção ou exclusão dos dados, ressalvadas as obrigações legais de retenção.

10. ACEITE ELETRÔNICO

Este contrato é assinado eletronicamente. São registrados, como prova do aceite: nome completo digitado pelo DEVEDOR, data e hora, endereço IP, dispositivo utilizado, documentos enviados e o código de verificação (hash) deste texto. O DEVEDOR declara que leu e concorda integralmente com as condições acima e que as informações prestadas são verdadeiras.

11. FORO

Fica eleito o foro da comarca do domicílio do DEVEDOR para dirimir questões deste contrato.
${revisor(lender)}`;
}

export const hashContract = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

/** As 12 primeiras posições do hash, agrupadas — fácil de conferir a olho. */
export const shortHash = (hash: string) => hash.slice(0, 12).toUpperCase().replace(/(.{4})/g, '$1 ').trim();

// ---------------------------------------------------------------------------
// Mensagens prontas para o WhatsApp
// ---------------------------------------------------------------------------
export interface MessageContext {
  firstName: string;
  contractNumber: string;
  installmentSeq?: number;
  installmentsCount?: number;
  amount?: number;
  dueDate?: string;      // YYYY-MM-DD
  lateDays?: number;
  totalDue?: number;
  pixKey?: string;
  pixOwner?: string;
  link?: string;
}

export function buildMessage(kind: 'PROPOSTA' | 'LEMBRETE' | 'ATRASO' | 'QUITACAO' | 'BOAS_VINDAS', c: MessageContext): string {
  const valor = c.amount != null ? brl(c.amount) : '';
  const venc = c.dueDate ? dateBr(c.dueDate) : '';
  const pix = c.pixKey ? `\n\nPix: ${c.pixKey}${c.pixOwner ? `\nEm nome de: ${c.pixOwner}` : ''}` : '';
  const parcela = c.installmentSeq && c.installmentsCount ? `parcela ${c.installmentSeq}/${c.installmentsCount}` : 'parcela';

  switch (kind) {
    case 'PROPOSTA':
      return `Olá, ${c.firstName}! Sua proposta de crédito está pronta.\n\nPara ver as condições, enviar seus documentos e assinar, acesse:\n${c.link}\n\nO link é pessoal e vale por 3 dias. Qualquer dúvida, é só chamar por aqui.`;
    case 'BOAS_VINDAS':
      return `${c.firstName}, tudo certo! Seu contrato ${c.contractNumber} foi liberado e o valor já foi enviado para a sua chave Pix.\n\nA primeira ${parcela} vence em ${venc}, no valor de ${valor}.${pix}\n\nAssim que pagar, me mande o comprovante que eu dou baixa na hora.`;
    case 'LEMBRETE':
      return `Bom dia, ${c.firstName}! Passando para lembrar da ${parcela} de hoje (${venc}): ${valor}.${pix}\n\nQuando pagar, me manda o comprovante, por favor.`;
    case 'ATRASO':
      return `${c.firstName}, a ${parcela} venceu em ${venc} e ainda não constou o pagamento${c.lateDays ? ` (${c.lateDays} ${c.lateDays === 1 ? 'dia' : 'dias'} de atraso)` : ''}.\n\nValor atualizado: ${c.totalDue != null ? brl(c.totalDue) : valor}.${pix}\n\nSe já tiver pago, me envia o comprovante. Se ficou apertado hoje, me chama que a gente combina uma data.`;
    case 'QUITACAO':
      return `${c.firstName}, contrato ${c.contractNumber} quitado! 🎉\n\nObrigado pela pontualidade. Com este ciclo concluído, você já pode pegar um valor maior no próximo. É só me chamar quando precisar.`;
  }
}

export const waLink = (whatsapp: string, message: string) =>
  `https://wa.me/${whatsapp.replace(/\D/g, '')}?text=${encodeURIComponent(message)}`;
