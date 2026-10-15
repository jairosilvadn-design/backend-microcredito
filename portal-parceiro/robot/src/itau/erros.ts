/** `retentavel`: o worker pode tentar de novo (timeout, rede). Falhas de login/seletor/negócio não repetem às cegas. */
export class RoboError extends Error {
  constructor(
    public readonly codigo: 'LOGIN_FALHOU' | 'ACAO_HUMANA' | 'ENVIO_INCERTO' | 'TIMEOUT' | 'SELETOR_NAO_ENCONTRADO' | 'PORTAL_INDISPONIVEL' | 'RESPOSTA_ILEGIVEL' | 'DADOS_INVALIDOS',
    message: string,
    public readonly retentavel = false,
    public readonly etapa?: string,
  ) { super(message); }
}
