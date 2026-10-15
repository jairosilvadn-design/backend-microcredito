// IDs do formulário e do resultado extraídos do "Simulador Isolado" salvo pelo usuário (HTML real do portal) — confiáveis.
// ⚠️ AINDA PLACEHOLDER: só o `menu` (a página salva não o contém). Com ITAU_URL_SIMULADOR definido o robô nem usa o menu.
// Grave-os com `npx playwright codegen <URL>` ou me envie prints/HTML da tela de login e do menu.
export const S = {
  // Login (página /Portal/, copiada do HTML real). O usuário é o E-MAIL cadastrado no portal.
  login: { usuario: '#txtUsuario', senha: '#txtSenha', entrar: '#btnEntrar' },
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
  // Tela "Enviar proposta → Isolado" (ids do HTML real salvo)
  proposta: {
    tipoImovel: '#tipoImovel', estadoImovel: '#EstadoImovel', valorImovel: '#Valor_Imovel', entrada: '#Valor_Entrada', prazo: '#Prazo_Financiamento',
    seguradora: '#Seguradora', sistema: '#Sistema_Amortizacao', taxaPadrao: '#taxa_padrao', taxaPoupanca: '#taxa_poupanca',
    financiarItbi: '#ckbValorITBI', percentualItbi: '#ValorITBI', financiarAvaliacao: '#ckbCustosAdicionais',
    p: { nome: '#Nome_Principal', nasc: '#Data_Nascimento_Principal', cpf: '#CPF_Principal', cep: '#CEP_Principal', endereco: '#Endereco_Principal',
         renda: '#Renda_Mensal_Liquida_Principal', tipoRenda: '#Tipo_Renda_Principal', cnpj: '#CNPJ_Principal', email: '#Email_Principal', tel: '#Telefone_01_Principal',
         estadoCivil: '#Estado_Civil_Principal', uniaoSim: '#radio_Uniao_EstavelY', uniaoNao: '#radio_Uniao_EstavelN' },
    c: { nome: '#Nome_Conjuge', cpf: '#CPF_Conjuge', nasc: '#Data_Nasc_Conjuge', tel: '#Telefone_01_Conjuge', estadoCivil: '#Estado_Civil_Conjuge' },
    compoeSim: '#Composicao_de_RendaY', compoeNao: '#Composicao_de_RendaN',
    s: { nome: '#Nome_Secundario', estadoCivil: '#Estado_Civil_Secundario', nasc: '#Data_Nasc_Secundario', cpf: '#CPF_Secundario', mesmoSim: '#rb_mesmoEndereco2CompradorY', mesmoNao: '#rb_mesmoEndereco2CompradorS',
         cep: '#CEP_Secundario', endereco: '#Endereco_Secundario', renda: '#Renda_Liquida_Secundario', tipoRenda: '#Tipo_Renda_Secundario', cnpj: '#CNPJ_Secundario', email: '#Email_Secundario', tel: '#Telefone_01_Secundario' },
    pdv: '#cmbPDVParceiro', canalSim: '#canal_imobiliariaY', canalNao: '#canal_imobiliariaN', codigoItau: '#txtCodigoItau',
    contatoSim: 'input[name=contato_proposta][value=true]', contatoNao: 'input[name=contato_proposta][value=false]',
    contatoNome: '#Nome_parceiro', contatoEmail: '#email_parceiro', contatoTel: '#Telefone_parceiro',
    avancar: '#btnEnviarDados', scr: '#chqScr', confirmar: '#btnConfirmardados',
  },
} as const;
