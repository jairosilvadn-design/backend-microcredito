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
/** Resposta de /api/Simulacao/EnviarSimulacaoModernizadaV2/ (a mesma que o botão Simular do portal usa para preencher a tela).
 *  É uma SIMULAÇÃO: não há "aprovado/recusado" (a aprovação só vem na análise da proposta). */
export interface ResultadoItau {
  status: 'SIMULADO';
  idSimulacao: string | number | null;
  dataSimulacao: string | null;
  prazoMeses: number | null;
  valorImovel: number | null;
  entrada: number | null;
  valorFinanciado: number | null;
  primeiraParcela: number | null;
  ultimaParcela: number | null;
  somatorioParcelas: number | null;
  sistema: 'SAC' | 'MIX' | string | null;
  linhaCredito: string | null;
  taxaJurosAnual: number | null;
  cetAnual: number | null;
  ceshAnual: number | null;
  iof: number | null;
  tarifaAdministracaoMensal: number | null;
  seguroMip: number | null;
  seguroDfi: number | null;
  valorTotalDevido: number | null;
  tarifaAvaliacao: number | null;
}

export interface PessoaProposta {
  nome: string; nascimento: string; cpf: string; cep: string; endereco: string; bairro: string; cidade: string; uf: string;
  rendaBruta: number; tipoRenda: string; cnpj: string; email: string; telefone: string;
}
/** Dados da tela "Enviar proposta → Isolado" (valores = os `value` das listas do portal). */
export interface DadosProposta {
  financiamento: {
    tipoImovel: 'RESIDENTIAL' | 'COMMERCIAL'; estadoImovel: string; valorImovel: number; entrada: number; prazoMeses: number;
    seguradora: string; sistema: 'SAC' | 'HYBRID'; taxa: 'STANDARD' | 'SAVINGS'; financiarItbi: boolean; percentualItbi: string; financiarAvaliacao: boolean;
  };
  principal: PessoaProposta & { estadoCivil: string; uniaoEstavel: boolean };
  conjuge: { nome: string; cpf: string; nascimento: string; telefone: string; estadoCivil: string } | null;
  compoeRenda: boolean;
  segundo: (Omit<PessoaProposta, 'nascimento'> & { nascimento: string; estadoCivil: string; mesmoEndereco: boolean }) | null;
  pdv: string;
  canal: { vincularParceiro: boolean; codigoItau: string };
  contato: { preferencial: boolean; nome: string; email: string; telefone: string };
}
export interface ResultadoProposta { status: 'ENVIADA' | 'PREENCHIDA'; numeroProposta: string | null }
