// IDs do formulário e do resultado extraídos do "Simulador Isolado" salvo pelo usuário (HTML real do portal) — confiáveis.
// ⚠️ AINDA PLACEHOLDER: `login` e `menu` (a página salva não contém a tela de login nem o menu, que são carregados por script).
// Grave-os com `npx playwright codegen <URL>` ou me envie prints/HTML da tela de login e do menu.
export const S = {
  login: { usuario: '#usuario', senha: '#senha', entrar: 'button[type=submit]', erro: '.mensagem-erro', logado: '#includeSidebar' }, // PLACEHOLDER
  menu: { simuladorIsolado: 'text=Simulador Isolado' },                                                                            // PLACEHOLDER
  form: {
    nome: '#txtNome', cpf: '#txtCPFPrincipal', nascimento: '#txtDataNascimentoPrimario', cep: '#txtCepPrincipal',
    renda: '#txtRendaPrincipal', celular: '#txtTelefone', email: '#txtEmail',
    segmento: '#PerfilCliente', estadoCivil: '#Estado_Civil_Principal',
    somarSim: '#Somar_rendaY', somarNao: '#Somar_rendaN',
    c2: { nome: '#txtNomeSegundoComprador', cpf: '#txtCPFSecundario', nascimento: '#txtDataNascimentoSecundario', cep: '#txtCepSecundario',
          renda: '#txtRendaSecundario', celular: '#txtTelefoneSecundario', email: '#txtEmailSecundario' },
    funcionario: '#funcionario',
    tipoImovel: '#cboTipoImovel', financiarItbi: '#chqFinanciarITBI', seguradora: '#cboSeguradora', sistema: '#cboSistemaAmortizacao',
    taxaPrefixada: '#taxa_padrao', taxaPoupanca: '#taxa_poupanca',
    valorImovel: '#txtValorImovel', entrada: '#txtValorEntrada', prazo: '#txtPrazoMeses',
    simular: '#btnSimular',
  },
  resultado: {
    pronto: '#lblValorPrimeiraParcela', prazo: '#lblPrazo', primeiraParcela: '#lblValorPrimeiraParcela', ultimaParcela: '#lblValorUltimaParcela',
    somatorio: '#lblValorSomatorioParcelas', totalFinanciado: '#colValorTotalFinanciamento', sistema: '#colSistemaAmortizacao',
    seguradora: '#colSeguradora', linhaCredito: '#colLinhaCredito', taxa: '#colTaxaJurosSimulada', cet: '#colCET', data: '#lblDataSimulacao',
  },
  sair: 'text=Sair', // PLACEHOLDER
} as const;
