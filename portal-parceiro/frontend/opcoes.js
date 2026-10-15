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

// ---- Tela "Enviar proposta → Isolado" do portal (copiado do HTML real; value = o que o portal envia, texto = o que o usuário vê) ----
export const propostaOpcoes = {
  tipoImovel: [['RESIDENTIAL', 'Residencial'], ['COMMERCIAL', 'Comercial']],
  seguradora: [['ITAÚ SEGUROS', 'ITAÚ SEGUROS'], ['TOKIO MARINE', 'TOKIO MARINE']],
  sistema: [['SAC', 'SAC'], ['HYBRID', 'MIX']],
  tipoRenda: [['Assalariado', 'Assalariado'], ['Aposentado', 'Aposentado'], ['Socio_Proprietario', 'Sócio Proprietário'], ['Autonomo', 'Autônomo'], ['Profissional_Liberal', 'Profissional Liberal']],
  estadoCivil: [['MARRIED', 'CASADO'], ['DIVORCED', 'DIVORCIADO'], ['SEPARATED', 'SEPARADO'], ['SINGLE', 'SOLTEIRO'], ['WIDOWER', 'VIUVO']],
  estadoCivilConjuge: [['DIVORCED', 'DIVORCIADO'], ['SEPARATED', 'SEPARADO'], ['SINGLE', 'SOLTEIRO'], ['WIDOWER', 'VIUVO']], // (cônjuge de união estável: sem "casado")
};
// Texto de consentimento que o portal exige marcar antes de enviar. É uma declaração do corretor sobre a autorização DO CLIENTE:
export const TEXTO_SCR = 'O cliente foi informado e autorizou a consulta das suas informações mantidas no sistema de informações de crédito (SCR) organizado pelo Banco Central do Brasil.';

// Limites da tela de proposta (title/min dos campos do portal): imóvel residencial a partir de R$ 33.000 (diferente do simulador).
export const VALOR_MIN_IMOVEL_PROPOSTA = { RESIDENTIAL: 33000, COMMERCIAL: 100000 }; // comercial: A CONFIRMAR
