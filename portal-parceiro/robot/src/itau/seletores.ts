// IDs do formulário e do resultado extraídos do "Simulador Isolado" salvo pelo usuário (HTML real do portal) — confiáveis.
// ⚠️ AINDA PLACEHOLDER: o botão de entrar do login e o `menu` (a página salva não contém a tela de login nem o menu).
// Grave-os com `npx playwright codegen <URL>` ou me envie prints/HTML da tela de login e do menu.
export const S = {
  // Login: página /Portal/ (form #loginForm, campos username/password — vistos em util.js). O botão ainda é PLACEHOLDER.
  login: { usuario: '#loginForm input[name=username]', senha: '#loginForm input[name=password]', entrar: '#loginForm button[type=submit]' },
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
} as const;
