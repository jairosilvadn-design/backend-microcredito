import pino from 'pino';
// Nunca logar credenciais nem CPF/renda do cliente.
export const log = pino({
  redact: ['*.senha', '*.password', '*.cliente', 'cliente', 'ITAU_SENHA', 'ITAU_USUARIO', '*.cpf'],
});
