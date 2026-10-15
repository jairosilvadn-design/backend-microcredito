export interface Comprador {
  nome: string; cpf: string; nascimento: string; // AAAA-MM-DD
  cep: string; rendaBruta: number; celular: string; email: string;
}
export interface DadosSimulacao {
  cliente: Comprador & { segmento: string; estadoCivil: string; funcionarioItau: boolean; segundoComprador: Comprador | null };
  operacao: {
    tipoImovel: string; seguradora: string; sistema: string; taxa: 'prefixada' | 'poupanca';
    financiarItbi: boolean; valorImovel: number; entrada: number; prazoMeses: number;
  };
}
/** Resultado da tela de simulação do portal (ids lbl e col). É uma SIMULAÇÃO: não há "aprovado/recusado". */
export interface ResultadoItau {
  status: 'SIMULADO';
  prazoMeses: number | null;
  primeiraParcela: number | null;
  ultimaParcela: number | null;
  somatorioParcelas: number | null;
  valorTotalFinanciado: number | null;
  sistema: string | null;
  seguradora: string | null;
  linhaCredito: string | null;
  taxaJuros: string | null;
  cet: string | null;
  dataSimulacao: string | null;
}
