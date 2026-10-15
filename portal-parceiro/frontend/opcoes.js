// Listas dos campos de seleção, copiadas do Simulador Isolado do Itaú (texto exatamente como no portal; o robô seleciona pelo TEXTO).
// Ainda não conhecidas (dependem de outra seleção e são carregadas por script): natureza do imóvel, localização,
// "em quantos meses pretende adquirir" e linha de crédito. Chegam quando tivermos os scripts do portal.
export const opcoes = {
  segmento: ['Não-correntista', 'Agências', 'Uniclass', 'Personnalite', 'Private', 'Outro'],
  estadoCivil: ['CASADO', 'DIVORCIADO', 'SEPARADO', 'SOLTEIRO', 'VIUVO'],
  tipoImovel: ['RESIDENCIAL', 'COMERCIAL'],
  seguradora: ['ITAU SEGUROS', 'TOKIO MARINE'],
  sistema: ['SAC', 'MIX'],
};
export const PRAZO_MIN = 12, PRAZO_MAX = 420; // limites do campo "Prazo (meses)" no portal
