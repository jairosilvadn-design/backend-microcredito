import { prisma } from '../../lib/prisma';

/** Documentos exigidos de quem nunca contratou conosco. */
export const REQUIRED_DOCS = ['DOC_FRONT', 'DOC_SELFIE', 'ADDRESS_PROOF'] as const;
export type RequiredDoc = (typeof REQUIRED_DOCS)[number];

export interface SituacaoDocs {
  /** Já assinou um contrato antes: o novo link é só um termo de aceite. */
  recorrente: boolean;
  /** Tipos que já estão arquivados e valem para este contrato. */
  enviados: Set<RequiredDoc>;
  /** O que ainda precisa ser enviado (vazio para quem já tem tudo arquivado). */
  faltando: RequiredDoc[];
  /** Chave Pix usada no contrato anterior, mascarada, para o cliente reconhecer. */
  pixAnterior: { tipo: string | null; mascarada: string } | null;
  /** Uso interno (nunca sai na API): chave completa do contrato anterior, para o aceite de um clique. */
  pixAnteriorCompleta: { chave: string; tipo: string } | null;
  /** Assinatura de um clique: já assinou antes, tem todos os arquivos e a chave Pix anterior. */
  umClique: boolean;
}

function mascarar(chave: string): string {
  if (chave.includes('@')) {
    const [u, d] = chave.split('@');
    return `${u!.slice(0, 1)}***@${d}`;
  }
  return chave.length <= 4 ? '****' : `***${chave.slice(-4)}`;
}

/**
 * Regra: foto de documento, selfie e comprovante só para quem NUNCA assinou um contrato.
 * Quem já assinou (mesmo que o contrato tenha sido quitado) reaproveita os arquivos do primeiro
 * cadastro e só confirma o aceite. Se faltar algum arquivo no cadastro antigo, pede apenas esse.
 * Nunca lê o conteúdo dos arquivos (só o tipo): é uma consulta leve.
 */
export async function situacaoDocumentos(borrowerId: string, contractId: string): Promise<SituacaoDocs> {
  const [docs, anterior] = await Promise.all([
    prisma.borrowerDocument.findMany({ where: { borrowerId }, select: { kind: true, contractId: true } }),
    prisma.creditContract.findFirst({
      where: { borrowerId, signedAt: { not: null }, NOT: { id: contractId } },
      orderBy: { signedAt: 'desc' },
      select: { signature: { select: { signerPixKey: true, signerPixKeyType: true } } },
    }),
  ]);

  const recorrente = Boolean(anterior);
  const validos = (recorrente ? docs : docs.filter((d) => d.contractId === contractId)).map((d) => d.kind as string);
  const enviados = new Set(REQUIRED_DOCS.filter((k) => validos.includes(k)));
  const faltando = REQUIRED_DOCS.filter((k) => !enviados.has(k));
  const chave = anterior?.signature?.signerPixKey;
  const tipo = anterior?.signature?.signerPixKeyType ?? null;
  return {
    recorrente, enviados, faltando,
    pixAnterior: chave ? { tipo, mascarada: mascarar(chave) } : null,
    pixAnteriorCompleta: chave && tipo ? { chave, tipo } : null,
    umClique: recorrente && faltando.length === 0 && Boolean(chave && tipo),
  };
}
