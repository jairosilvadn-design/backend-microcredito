// Listas dos campos de seleção. As 3 primeiras vêm do Simulador Isolado do Itaú (texto exatamente como no portal).
// ⚠️ A CONFIRMAR: tipoImovel, seguradora e sistema são carregadas por script no portal e não vieram no arquivo salvo.
// Confira no portal (abra cada lista) e ajuste aqui: o valor enviado ao robô é o TEXTO da opção.
export const opcoes = {
  segmento: ['Não-correntista', 'Agências', 'Uniclass', 'Personnalite', 'Private', 'Outro'],
  estadoCivil: ['CASADO', 'DIVORCIADO', 'SEPARADO', 'SOLTEIRO', 'VIUVO'],
  tipoImovel: ['Residencial'],        // A CONFIRMAR
  seguradora: ['Itaú Seguros'],       // A CONFIRMAR
  sistema: ['SAC', 'PRICE'],          // A CONFIRMAR (texto exato da lista do portal)
};
export const PRAZO_MIN = 12, PRAZO_MAX = 420; // limites do campo "Prazo (meses)" no portal
