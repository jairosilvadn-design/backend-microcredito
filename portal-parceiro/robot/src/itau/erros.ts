/** `retentavel`: o worker pode tentar de novo (timeout, rede). Falhas de login/seletor/negócio não repetem às cegas. */
export class RoboError extends Error {
  constructor(
    public readonly codigo: 'LOGIN_FALHOU' | 'ACAO_HUMANA' | 'SESSAO_EXPIRADA' | 'ENVIO_INCERTO' | 'TIMEOUT' | 'SELETOR_NAO_ENCONTRADO' | 'PORTAL_INDISPONIVEL' | 'RESPOSTA_ILEGIVEL' | 'DADOS_INVALIDOS',
    message: string,
    public readonly retentavel = false,
    public readonly etapa?: string,
    /** Diagnóstico técnico SEM dados pessoais nem credenciais (url, status HTTP, textos de aviso da tela). Vai para o log e para erro.detalhe. */
    public readonly detalhe?: string,
  ) { super(message); }
}
