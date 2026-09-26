/**
 * O GESTOR DA CARTEIRA
 *
 * Aqui mora a matemática que decide quanto emprestar, para quem e quando.
 * Três regras clássicas do microcrédito, com números já calibrados para quem
 * começa pequeno (referências: metodologia de crédito progressivo do Grameen
 * Bank e do BRI da Indonésia, e os indicadores de carteira usados pelo CGAP/
 * Banco Mundial). Nada aqui precisa ser configurado para funcionar.
 *
 *   1. RESERVA      guarda parte do dinheiro para aguentar calote sem parar o giro
 *   2. CONCENTRAÇÃO nenhum cliente pode carregar uma fatia grande demais da carteira
 *   3. FOLGA        não empresta o que vai fazer falta nos próximos dias
 *
 * Todas as funções são puras: recebem números, devolvem números e o motivo
 * de cada decisão em português simples.
 */

export interface PadroesOperacao {
  /** % do que está na rua que fica guardado em caixa. */
  reservaPercent: number;
  /** % do patrimônio que um único cliente pode carregar. */
  concentracaoPercent: number;
  /** Atraso acima do qual o crescimento é travado (% da carteira). */
  atrasoLimitePercent: number;
  /** Valor mínimo de um contrato: abaixo disso não compensa operar. */
  contratoMinimo: number;
}

/**
 * MODOS DE OPERAÇÃO
 *
 * O sistema muda de postura conforme o tamanho da carteira, sozinho.
 *
 * ARRANCADA (até R$ 3.000): caixa pequeno, dinheiro parado dói mais que calote.
 *   Guarda pouco e aceita mais peso por cliente para colocar tudo na rua.
 * EQUILIBRADO (até R$ 10.000): começa a se proteger sem travar o giro.
 * CONSERVADOR (acima disso): a carteira já vale mais que a pressa.
 *
 * A troca é automática, e você pode fixar um modo à mão se quiser.
 */
export type Modo = 'ARRANCADA' | 'EQUILIBRADO' | 'CONSERVADOR';

export const MODOS: Record<Modo, PadroesOperacao & { atePatrimonio: number; apelido: string; resumo: string }> = {
  ARRANCADA: {
    atePatrimonio: 3000, apelido: 'Arrancada',
    reservaPercent: 5, concentracaoPercent: 35, atrasoLimitePercent: 15, contratoMinimo: 100,
    resumo: 'Caixa pequeno: quase tudo vai para a rua. Guardo só 5% de reserva e aceito até 35% do dinheiro em um mesmo cliente. Rende mais rápido, mas um calote pesa bastante — por isso prefira vários contratos pequenos a um grande.',
  },
  EQUILIBRADO: {
    atePatrimonio: 10000, apelido: 'Equilibrado',
    reservaPercent: 10, concentracaoPercent: 25, atrasoLimitePercent: 12, contratoMinimo: 100,
    resumo: 'A carteira cresceu: guardo 10% de reserva e limito cada cliente a 25% do dinheiro. Continua girando rápido, já com alguma proteção.',
  },
  CONSERVADOR: {
    atePatrimonio: Number.POSITIVE_INFINITY, apelido: 'Conservador',
    reservaPercent: 15, concentracaoPercent: 15, atrasoLimitePercent: 10, contratoMinimo: 100,
    resumo: 'Carteira grande: proteger o que já foi construído passa a valer mais que a pressa. Guardo 15% e limito cada cliente a 15%.',
  },
};

/** Descobre o modo pelo tamanho da carteira (ou usa o que você fixou). */
export function modoPara(patrimonio: number, fixado?: Modo | 'AUTO'): { modo: Modo; padroes: PadroesOperacao; apelido: string; resumo: string; automatico: boolean } {
  const escolhido: Modo = fixado && fixado !== 'AUTO'
    ? fixado
    : patrimonio <= MODOS.ARRANCADA.atePatrimonio ? 'ARRANCADA'
      : patrimonio <= MODOS.EQUILIBRADO.atePatrimonio ? 'EQUILIBRADO'
        : 'CONSERVADOR';
  const m = MODOS[escolhido];
  return {
    modo: escolhido,
    padroes: { reservaPercent: m.reservaPercent, concentracaoPercent: m.concentracaoPercent, atrasoLimitePercent: m.atrasoLimitePercent, contratoMinimo: m.contratoMinimo },
    apelido: m.apelido,
    resumo: m.resumo,
    automatico: !fixado || fixado === 'AUTO',
  };
}

/** Padrão usado quando nada é informado (começo de operação). */
export const PADROES: PadroesOperacao = modoPara(0).padroes;

const r2 = (n: number) => Math.round(n * 100) / 100;
const brl = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// ---------------------------------------------------------------------------
// 1) Situação do caixa
// ---------------------------------------------------------------------------
export interface CaixaInput {
  saldoCaixa: number;          // soma dos lançamentos
  principalNaRua: number;      // capital emprestado ainda não recuperado
  aReceberProximos7Dias: number;
  padroes?: PadroesOperacao;
}

export interface CaixaResultado {
  saldoCaixa: number;
  reservaGuardada: number;
  disponivelParaEmprestar: number;
  patrimonio: number;          // caixa + capital na rua
  ociosoPercent: number;       // quanto do dinheiro está parado
  naRuaPercent: number;        // quanto está trabalhando
  explicacao: string;
}

export function situacaoCaixa(i: CaixaInput): CaixaResultado {
  const p = i.padroes ?? PADROES;
  const reserva = r2(i.principalNaRua * (p.reservaPercent / 100));
  const disponivel = r2(Math.max(0, i.saldoCaixa - reserva));
  const patrimonio = r2(i.saldoCaixa + i.principalNaRua);

  const explicacao = i.principalNaRua > 0
    ? `Você tem ${brl(i.saldoCaixa)} em caixa. Guardo ${brl(reserva)} como reserva (${p.reservaPercent}% do que está na rua, para aguentar um calote sem travar o giro). Sobram ${brl(disponivel)} para emprestar hoje.`
    : `Você tem ${brl(i.saldoCaixa)} em caixa e nada emprestado ainda. Pode usar tudo para começar.`;

  const ociosoPercent = patrimonio > 0 ? r2((disponivel / patrimonio) * 100) : 0;
  const naRuaPercent = patrimonio > 0 ? r2((i.principalNaRua / patrimonio) * 100) : 0;

  return {
    saldoCaixa: r2(i.saldoCaixa), reservaGuardada: reserva, disponivelParaEmprestar: disponivel, patrimonio,
    ociosoPercent, naRuaPercent, explicacao,
  };
}

// ---------------------------------------------------------------------------
// 2) Quanto liberar para um cliente
// ---------------------------------------------------------------------------
export interface LimiteInput {
  capacidadeCliente: number;   // do motor de segmento/extrato
  tetoDoNivel: number;
  patrimonio: number;
  jaEmprestadoAoCliente: number;
  disponivelParaEmprestar: number;
  padroes?: PadroesOperacao;
}

export interface LimiteResultado {
  valorSugerido: number;
  travadoPor: 'CAPACIDADE' | 'NIVEL' | 'CONCENTRACAO' | 'CAIXA';
  motivo: string;
  limites: Array<{ nome: string; valor: number; explicacao: string }>;
  podeEmprestar: boolean;
}

export function limiteParaCliente(i: LimiteInput): LimiteResultado {
  const p = i.padroes ?? PADROES;
  // A regra dos 15% protege a carteira, mas no começo ela travaria até o primeiro
  // contrato. Por isso existe um piso: dois contratos mínimos por cliente.
  // Quando o negócio cresce, a regra dos 15% passa a mandar sozinha.
  const tetoCliente = Math.max(i.patrimonio * (p.concentracaoPercent / 100), p.contratoMinimo * 2);
  const porConcentracao = r2(Math.max(0, tetoCliente - i.jaEmprestadoAoCliente));

  const limites = [
    { nome: 'CAPACIDADE' as const, valor: r2(i.capacidadeCliente), explicacao: 'o quanto o caixa do comércio dele aguenta pagar' },
    { nome: 'NIVEL' as const, valor: r2(i.tetoDoNivel), explicacao: 'o teto do nível em que ele está hoje' },
    { nome: 'CONCENTRACAO' as const, valor: porConcentracao, explicacao: i.patrimonio * (p.concentracaoPercent / 100) >= p.contratoMinimo * 2
      ? `no máximo ${p.concentracaoPercent}% do seu dinheiro em um único cliente`
      : `o limite de segurança por cliente enquanto a carteira é pequena (${brl(p.contratoMinimo * 2)})` },
    { nome: 'CAIXA' as const, valor: r2(i.disponivelParaEmprestar), explicacao: 'o que sobra no seu caixa depois da reserva' },
  ];

  const menor = limites.reduce((a, b) => (a.valor <= b.valor ? a : b));
  // Arredonda para baixo em múltiplos de 50: fica redondo para o cliente.
  const valor = Math.max(0, Math.floor(menor.valor / 50) * 50);

  const motivo = valor < p.contratoMinimo
    ? `Hoje não dá para emprestar para este cliente: ${menor.explicacao} limita em ${brl(menor.valor)}, abaixo do contrato mínimo de ${brl(p.contratoMinimo)}.`
    : `Pode liberar até ${brl(valor)}. Quem manda neste número é ${menor.explicacao} (${brl(menor.valor)}).`;

  return { valorSugerido: valor, travadoPor: menor.nome, motivo, limites, podeEmprestar: valor >= p.contratoMinimo };
}

// ---------------------------------------------------------------------------
// 3) Saúde da carteira
// ---------------------------------------------------------------------------
export interface SaudeInput {
  carteiraTotal: number;        // a receber dos contratos em aberto
  emAtrasoAte30: number;
  emAtrasoMais30: number;
  liberadoTotal: number;
  jurosRecebidos: number;
  diasOperando: number;
  saldoCaixa: number;
  padroes?: PadroesOperacao;
}

export interface SaudeResultado {
  atrasoPercent: number;
  provisaoSugerida: number;
  lucroLimpo: number;
  giroAnualEstimado: number;
  semaforo: 'VERDE' | 'AMARELO' | 'VERMELHO';
  podeCrescer: boolean;
  frases: string[];
}

/**
 * Provisão: dinheiro que separo do lucro porque parte do atraso não volta.
 * Percentuais no espírito da tabela do Banco Central (Resolução 2.682),
 * simplificados em duas faixas para uma carteira pequena.
 */
export function saudeDaCarteira(i: SaudeInput): SaudeResultado {
  const p = i.padroes ?? PADROES;
  const atrasoTotal = i.emAtrasoAte30 + i.emAtrasoMais30;
  const atrasoPercent = i.carteiraTotal > 0 ? r2((atrasoTotal / i.carteiraTotal) * 100) : 0;
  const provisao = r2(i.emAtrasoAte30 * 0.2 + i.emAtrasoMais30 * 0.7);
  const lucroLimpo = r2(i.jurosRecebidos - provisao);
  const giro = i.diasOperando > 0 && i.liberadoTotal > 0
    ? r2((i.liberadoTotal / Math.max(1, i.saldoCaixa + i.carteiraTotal)) * (365 / i.diasOperando))
    : 0;

  const semaforo = atrasoPercent >= p.atrasoLimitePercent ? 'VERMELHO' : atrasoPercent >= p.atrasoLimitePercent / 2 ? 'AMARELO' : 'VERDE';
  const frases: string[] = [];

  if (semaforo === 'VERDE') frases.push(`Carteira saudável: ${atrasoPercent.toLocaleString('pt-BR')}% em atraso. Pode crescer.`);
  if (semaforo === 'AMARELO') frases.push(`Atenção: ${atrasoPercent.toLocaleString('pt-BR')}% da carteira está atrasada. Cresça devagar e aperte a cobrança.`);
  if (semaforo === 'VERMELHO') frases.push(`Pare de crescer: ${atrasoPercent.toLocaleString('pt-BR')}% da carteira está atrasada (o limite seguro é ${p.atrasoLimitePercent}%). Concentre-se em receber o que está na rua.`);
  if (provisao > 0) frases.push(`Do lucro que aparece na tela, ${brl(provisao)} podem não entrar por causa dos atrasos. Não conte com esse dinheiro.`);
  if (giro > 0) frases.push(`No ritmo atual, seu dinheiro dá cerca de ${giro.toLocaleString('pt-BR', { maximumFractionDigits: 1 })} voltas por ano.`);

  return { atrasoPercent, provisaoSugerida: provisao, lucroLimpo, giroAnualEstimado: giro, semaforo, podeCrescer: semaforo !== 'VERMELHO', frases };
}

// ---------------------------------------------------------------------------
// 4) Projeção de caixa e momento de buscar cliente novo
// ---------------------------------------------------------------------------
export interface ProjecaoInput {
  saldoHoje: number;
  reserva: number;
  /** Quanto entra em cada dia futuro: { '2026-09-26': 54.5, ... } */
  entradasPorDia: Record<string, number>;
  dias: string[];               // dias em ordem
  contratoMinimo: number;
}

export interface ProjecaoResultado {
  linha: Array<{ dia: string; entra: number; saldo: number; disponivel: number }>;
  primeiroDiaComDinheiro: string | null;
  totalProximos7: number;
  totalProximos30: number;
  contratosPossiveis30Dias: number;
}

export function projetarCaixa(i: ProjecaoInput): ProjecaoResultado {
  let saldo = i.saldoHoje;
  const linha = i.dias.map((dia) => {
    const entra = r2(i.entradasPorDia[dia] ?? 0);
    saldo = r2(saldo + entra);
    return { dia, entra, saldo, disponivel: r2(Math.max(0, saldo - i.reserva)) };
  });

  const primeiro = linha.find((l) => l.disponivel >= i.contratoMinimo)?.dia ?? null;
  const soma = (n: number) => r2(linha.slice(0, n).reduce((s, l) => s + l.entra, 0));
  const total30 = soma(30);

  return {
    linha,
    primeiroDiaComDinheiro: primeiro,
    totalProximos7: soma(7),
    totalProximos30: total30,
    contratosPossiveis30Dias: Math.floor((Math.max(0, i.saldoHoje - i.reserva) + total30) / Math.max(1, i.contratoMinimo)),
  };
}

// ---------------------------------------------------------------------------
// 5) O que fazer hoje
// ---------------------------------------------------------------------------
export interface RecomendacaoInput {
  caixa: CaixaResultado;
  saude: SaudeResultado;
  projecao: ProjecaoResultado;
  clientesAtivos: number;
  clientesProntosParaSubir: number;
  parcelasAtrasadas: number;
  contratosAguardandoAssinatura: number;
  /** Contratos já em vigor cujo Pix ainda não foi confirmado como enviado. */
  pixAEnviar: number;
  diasCaixaParado: number;
  padroes?: PadroesOperacao;
}

export interface Recomendacao {
  ordem: number;
  titulo: string;
  detalhe: string;
  tom: 'BOM' | 'ATENCAO' | 'URGENTE';
  acao?: 'COBRAR' | 'LIBERAR' | 'PROSPECTAR' | 'ASSINATURA' | 'SUBIR_NIVEL' | 'APORTAR';
}

/** A lista de tarefas do dia, na ordem em que dá mais dinheiro resolver. */
export function recomendacoes(i: RecomendacaoInput): Recomendacao[] {
  const p = i.padroes ?? PADROES;
  const lista: Recomendacao[] = [];
  let ordem = 1;

  if (i.parcelasAtrasadas > 0) {
    lista.push({
      ordem: ordem++,
      titulo: `Cobre ${i.parcelasAtrasadas} parcela${i.parcelasAtrasadas > 1 ? 's' : ''} em atraso`,
      detalhe: 'Dinheiro atrasado é dinheiro que não está girando. Comece o dia por aqui: a mensagem já está pronta na tela de Cobranças.',
      tom: 'URGENTE',
      acao: 'COBRAR',
    });
  }

  if (i.pixAEnviar > 0) {
    lista.push({
      ordem: ordem++,
      titulo: `Envie o Pix de ${i.pixAEnviar} contrato${i.pixAEnviar > 1 ? 's' : ''} assinado${i.pixAEnviar > 1 ? 's' : ''}`,
      detalhe: 'O cliente assinou e o contrato já está valendo: as parcelas começaram a contar. Confira as fotos dos documentos, mande o Pix e marque como enviado.',
      tom: 'URGENTE',
      acao: 'LIBERAR',
    });
  }

  if (!i.saude.podeCrescer) {
    lista.push({
      ordem: ordem++,
      titulo: 'Segure os empréstimos novos por enquanto',
      detalhe: i.saude.frases[0] ?? 'A carteira está com muito atraso. Receba antes de emprestar mais.',
      tom: 'URGENTE',
    });
  } else if (i.caixa.disponivelParaEmprestar >= p.contratoMinimo) {
    const quantos = Math.floor(i.caixa.disponivelParaEmprestar / p.contratoMinimo);
    const parado = i.caixa.ociosoPercent;
    lista.push({
      ordem: ordem++,
      titulo: `${brl(i.caixa.disponivelParaEmprestar)} parados: dá para ${quantos} contrato${quantos > 1 ? 's' : ''}`,
      detalhe: parado >= 40
        ? `${parado.toLocaleString('pt-BR')}% do seu dinheiro está parado${i.diasCaixaParado > 2 ? ` há ${i.diasCaixaParado} dias` : ''}. Parado ele não rende nada; na rua, cada R$ 100 devolvem cerca de R$ 20 por ciclo. Prioridade do dia: colocar esse dinheiro para trabalhar.`
        : `Esse dinheiro não rende parado${i.diasCaixaParado > 2 ? ` e já são ${i.diasCaixaParado} dias assim` : ''}. Procure cliente novo ou ofereça um novo ciclo a quem já quitou.`,
      tom: parado >= 40 || i.diasCaixaParado > 2 ? 'ATENCAO' : 'BOM',
      acao: 'PROSPECTAR',
    });

    if (quantos >= 2 && i.clientesAtivos < 4) {
      lista.push({
        ordem: ordem++,
        titulo: 'Divida em mais clientes, não em contratos maiores',
        detalhe: `Com ${i.clientesAtivos} cliente${i.clientesAtivos === 1 ? '' : 's'} na carteira, um calote derruba o resultado do mês. ${quantos} contratos menores rendem quase o mesmo e espalham o risco.`,
        tom: 'ATENCAO',
        acao: 'PROSPECTAR',
      });
    }
  }

  if (i.clientesProntosParaSubir > 0) {
    lista.push({
      ordem: ordem++,
      titulo: `${i.clientesProntosParaSubir} cliente${i.clientesProntosParaSubir > 1 ? 's' : ''} pronto para pegar mais`,
      detalhe: 'Quitaram o ciclo em dia e subiram de nível. São os melhores clientes que você tem: ofereça um valor maior antes que procurem outro lugar.',
      tom: 'BOM',
      acao: 'SUBIR_NIVEL',
    });
  }

  if (i.contratosAguardandoAssinatura > 0) {
    lista.push({
      ordem: ordem++,
      titulo: `${i.contratosAguardandoAssinatura} proposta aguardando assinatura`,
      detalhe: 'O link vence em poucos dias. Se o cliente não abriu, mande uma mensagem lembrando.',
      tom: 'ATENCAO',
      acao: 'ASSINATURA',
    });
  }

  if (i.caixa.disponivelParaEmprestar < p.contratoMinimo && i.projecao.primeiroDiaComDinheiro) {
    const [a, m, d] = i.projecao.primeiroDiaComDinheiro.split('-');
    lista.push({
      ordem: ordem++,
      titulo: `Próximo contrato possível em ${d}/${m}`,
      detalhe: `Até lá entram ${brl(i.projecao.totalProximos7)} das parcelas dos próximos 7 dias. Vá conversando com possíveis clientes desde já, para o dinheiro não ficar parado quando chegar.`,
      tom: 'BOM',
      acao: 'PROSPECTAR',
    });
  }

  if (i.clientesAtivos === 0) {
    lista.push({
      ordem: ordem++,
      titulo: 'Comece cadastrando o primeiro cliente',
      detalhe: 'Cadastre um comerciante, simule o valor e envie o link do contrato pelo WhatsApp. O sistema cuida do resto.',
      tom: 'BOM',
      acao: 'PROSPECTAR',
    });
  }

  if (i.caixa.saldoCaixa <= 0 && i.clientesAtivos > 0) {
    lista.push({
      ordem: ordem++,
      titulo: 'Seu caixa zerou',
      detalhe: 'Todo o dinheiro está na rua. Ou você espera as parcelas entrarem, ou coloca mais capital pela tela de Caixa.',
      tom: 'ATENCAO',
      acao: 'APORTAR',
    });
  }

  return lista;
}

export { brl };
