// Listas dos campos de seleção, copiadas do Simulador Isolado do Itaú (texto exatamente como no portal; o robô seleciona pelo TEXTO).
// Natureza do imóvel, localização, "meses para adquirir" e linha de crédito NÃO são enviados pelo simulador atual
// (o portal os desativou em jul/2022 e fixa a localização em "SP"), então o nosso formulário não pede esses campos.
export const opcoes = {
  segmento: ['Não-correntista', 'Agências', 'Uniclass', 'Personnalite', 'Private', 'Outro'],
  estadoCivil: ['CASADO', 'DIVORCIADO', 'SEPARADO', 'SOLTEIRO', 'VIUVO'],
  tipoImovel: ['RESIDENCIAL', 'COMERCIAL'],
  seguradora: ['ITAU SEGUROS', 'TOKIO MARINE'],
  sistema: ['SAC', 'MIX'],
};
// Regras do simulador do portal (simulador_de_financiamento_isolado.js):
export const VALOR_MIN_IMOVEL = { RESIDENCIAL: 97561, COMERCIAL: 100000 };
export const ENTRADA_MIN_PERCENTUAL = 20;          // financia no máximo 80% do valor do imóvel
export const PRAZO_MAX_MESES = { RESIDENCIAL: 420, COMERCIAL: 240 };
export const PRAZO_MIN_MESES = 12, PRAZO_MIN_MIX_RESIDENCIAL = 48;
export const IDADE_PRAZO_MAX_MESES = 966;           // A CONFIRMAR (vem de prazos.js, que não temos): idade + prazo <= 80a6m. O portal valida de novo.
