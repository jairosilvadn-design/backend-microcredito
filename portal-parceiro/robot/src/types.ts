export interface DadosSimulacao {
  cliente: { cpf: string; nascimento: string; rendaBruta: number; fgts: boolean; fgtsValor: number };
  operacao: { valorImovel: number; valorFinanciamento: number; sistema: 'SAC' | 'PRICE' };
}
export interface ResultadoItau {
  status: 'APROVADO' | 'RECUSADO' | 'EM_ANALISE';
  valorAprovado: number | null;
  taxaJurosAnual: number | null;
  numeroProposta: string | null;
  motivo: string | null;
}
