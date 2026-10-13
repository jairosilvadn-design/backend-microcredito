# Backend — Microcrédito com Split Mercado Pago (Etapas 2, 3 e 4)

## Setup
1. `npm install`
2. `cp .env.example .env` e preencha. Gere a chave de criptografia com `npm run gen:key`.
3. `npx prisma migrate dev --name init` (quem já rodou a Etapa 1: `npx prisma migrate dev --name etapa4`)
4. `npm run dev`

## Rotas
Rotas com (op) exigem `Authorization: Bearer <ID token do Firebase>` de um e-mail cadastrado na tabela Operator.

- `POST /api/merchants/:id/oauth-link` (op): gera o link de vinculação.
- `POST /api/charges/pix-balcao` (op): Pix com split (application_fee). Header `Idempotency-Key` obrigatório.
- `POST /api/charges/link-pagamento` (op): preferência Checkout Pro com marketplace_fee. Header `Idempotency-Key` obrigatório.
- `POST /api/charges/avulsa` (op): Pix na conta matriz, sem split. Header `Idempotency-Key` obrigatório.
- `GET  /api/charges/:id/status` (op): status leve para polling.
- `GET  /oauth/mercadopago/callback`: Redirect URL cadastrada no painel MP.
- `POST /webhooks/mercadopago`: URL de webhook (evento Pagamentos).
- `GET  /api/me` (op): perfil do operador logado.
- `GET  /api/dashboard/overview?date=AAAA-MM-DD` (op): semáforo da carteira.
- `GET  /api/merchants/:id/audits?days=30` (op): histórico diário.
- `GET  /api/merchants/:id/statement?date=AAAA-MM-DD` (op): extrato classificado (evidência e calibragem).
- `GET  /api/alerts` (op) e `POST /api/alerts/:id/review` (op): START_REVIEW, CONFIRM, DISMISS, RESOLVE.
- `POST /api/notices/:id/approve | sent | cancel` (admin): vencimento antecipado.
- `POST /api/audit/run` (admin): roda/recalcula a auditoria manualmente (sem cobranças por padrão).
- `GET  /health`

## Jobs (somente com ENABLE_JOBS=true, em UMA instância)
- Renovação de tokens: de hora em hora, renova quem expira em menos de TOKEN_REFRESH_WINDOW_DAYS.
- Reprocessamento de webhooks: a cada 5 min, tenta de novo eventos não processados.
- Auditoria diária (AUDIT_CRON, padrão 06:00): sincroniza o extrato, audita D-1, recupera até AUDIT_BACKFILL_DAYS dias perdidos.

## Regras do semáforo (src/services/audit/rules.ts)
- VERDE: retenção do dia >= parcela do dia e sem desvio.
- AMARELO: retenção abaixo da parcela (gera Pix avulso na conta matriz + WhatsApp) ou 1º dia de venda fora do split.
- VERMELHO: vendas fora do split por graceDaysForBreach dias seguidos (padrão 2). Gera alerta crítico + notificação em RASCUNHO.
- Dia sem vendas e dia com extrato indisponível são neutros para o contador.
- Tolerância: BYPASS_MIN_AMOUNT e BYPASS_MIN_COUNT.

## Template do WhatsApp (opcional)
Crie na Meta um template de categoria Utilidade, idioma pt_BR, com 3 variáveis:
"Olá, {{1}}! A parcela de hoje do seu contrato ficou em aberto: {{2}}. Para pagar via Pix, acesse: {{3}}"
e informe o nome em WHATSAPP_TEMPLATE_COBRANCA. Sem isso, o dashboard mostra o botão "Enviar pelo WhatsApp" (wa.me).

## Testes
`npm test` roda o motor de regras, datas, classificação, paginação do extrato e permissões.

## Rotação da chave de criptografia
1. Adicione a nova chave: `TOKEN_ENC_KEYS=v1:CHAVE_ANTIGA,v2:CHAVE_NOVA`
2. Troque `TOKEN_ENC_ACTIVE_KID=v2`
3. Tokens são regravados com a v2 na próxima leitura/renovação. Remova a v1 só depois que nenhum registro começar com "v1.".

## Crédito: regras financeiras (motor único)

Toda conta de saldo, baixa e relatório sai de `src/services/credit/ledger.service.ts`.

- **Mora**: multa (uma vez) + juros ao dia sobre o valor da parcela, do vencimento até o dia do pagamento (ou hoje, se aberta). Parcela quitada congela a mora.
- **Baixa**: abate primeiro a mora, depois a parcela. Sem valor informado, quita a parcela com a mora do dia (o mesmo número da tela de cobranças). Valor maior que a parcela transborda para as próximas; maior que o saldo do contrato é recusado.
- **Caixa**: cada pagamento = 1 lançamento `RECEBIMENTO`; estorno = lançamento inverso. Lançamentos de contrato não podem ser apagados.
- **Capital / lucro**: capital = valor líquido que saiu do caixa. Recebido = capital que voltou + lucro (mora é 100% lucro). Painel, gestor e resumo usam a mesma função (`posicaoDoContrato`).
- **Concorrência**: baixa, estorno, renegociação, cancelamento e régua diária travam a linha do contrato (`SELECT … FOR UPDATE`); o aceite da assinatura só grava uma vez.

Rotas novas (admin): `POST /api/credito/pagamentos/:id/estornar` e `POST /api/credito/conferir[?corrigir=true]`
(a conferência compara parcelas, saldo e caixa com os pagamentos e, com `corrigir=true`, refaz os saldos e lança ajustes de caixa rastreáveis).

## Testes
- `npm test` — lógica pura (sem banco).
- `npm run test:db` — integração em **Postgres local descartável** (`DATABASE_URL`/`DIRECT_URL` apontando para localhost; o teste recusa outros hosts e apaga as tabelas de crédito).

<!-- deploy: variáveis de ambiente do Netlify configuradas -->

## Cliente recorrente (novo contrato sem fotos)
Documento, selfie e comprovante de endereço só são pedidos a quem **nunca assinou** um contrato. Quem já assinou (mesmo com o contrato quitado) reaproveita os arquivos do primeiro cadastro: o link vira apenas um **termo de aceite de um clique**: a tela mostra só o botão **Assinar** (`quickSign: true`) e envia `{ "agreed": true }`. Nome, CPF/CNPJ e chave Pix saem do cadastro e do contrato anterior; IP, aparelho, data e hash do texto ficam registrados. Se faltar algum arquivo no cadastro antigo, pede só o que falta.
- `GET /p/contrato/:token` agora traz `returningClient`, `documentsRequired`, `missingDocuments` e `previousPixKey` (mascarada).
- `POST /api/credito/contratos` e `/reenviar` devolvem `clienteRecorrente`; a mensagem do WhatsApp muda ("não precisa enviar documentos").
- `GET /api/credito/contratos/:id` traz `documentosEfetivos` e `documentosReaproveitados`.

## Velocidade
- Respostas guardadas por até 20–30 s **e** validadas por uma consulta leve ("mudou algo?") que vale entre todas as cópias da função.
- Operador e configurações guardados por 60 s / 30 s por cópia.
- `keep-warm` (agendada, 07h–20h de Brasília) mantém a função e o banco acordados. Para desligar, crie `KEEP_WARM=off` no Netlify.

## Página de assinatura (`public/assinatura.html`)
Servida pelo próprio Netlify em `APP_PUBLIC_URL/assinatura.html?t=<token>`; fala com a API no mesmo endereço (sem CORS).
- Cliente novo: tira as 3 fotos (reduzidas no celular antes de enviar), preenche nome, CPF/CNPJ e Pix e assina.
- Cliente recorrente (`quickSign: true`): só o botão **Assinar**.
- Cabeçalhos no `netlify.toml`: sem cache, sem `Referer`, sem iframe, CSP restrito (o token está na URL).
- Teste no navegador (Chromium, tela de celular): `npm run test:db` (inclui `tests/assinatura.e2e.test.ts`).
