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
