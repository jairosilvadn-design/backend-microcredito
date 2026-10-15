// ⚠️ PLACEHOLDERS. Eu não tenho acesso ao Portal do Correspondente: grave os seletores reais com
// `npx playwright codegen <URL>` na sua máquina e preencha aqui. Preferir data-testid / getByRole / getByLabel.
// Concentrar tudo neste arquivo é de propósito: quando o Itaú mudar o HTML, só este arquivo muda.
export const S = {
  login: { usuario: '#usuario', senha: '#senha', entrar: 'button[type=submit]', erro: '.mensagem-erro', logado: '#menu-principal' },
  menu: { novaProposta: 'text=Nova Proposta' },
  form: {
    cpf: '#cpf', nascimento: '#dataNascimento', renda: '#rendaBruta',
    fgtsSim: '#fgts-sim', fgtsNao: '#fgts-nao', fgtsValor: '#valorFgts',
    valorImovel: '#valorImovel', valorFinanciamento: '#valorFinanciamento',
    sistema: '#sistemaAmortizacao', enviar: 'button:has-text("Simular")',
  },
  resultado: {
    container: '#resultado-simulacao', status: '.status', valorAprovado: '.valor-aprovado',
    taxa: '.taxa-juros', proposta: '.numero-proposta', motivo: '.motivo',
  },
  sair: 'text=Sair',
} as const;
