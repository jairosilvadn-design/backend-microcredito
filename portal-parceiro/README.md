# Portal do Parceiro — Crédito Imobiliário (White Label)

Stack obrigatória: **GitHub** (código) · **Netlify** (front) · **Firebase** (Auth + Firestore). O robô é Node.js + Playwright.
Esta pasta é independente do restante do repositório (tem `package.json`/`netlify.toml` próprios).

## ⚠️ Antes de construir: 3 pontos que decidem o projeto
1. **Contrato/termos com o Itaú.** Automatizar o portal com a sua credencial de correspondente pode violar o termo de uso do portal
   (uso por robô, compartilhamento de acesso com terceiros — as imobiliárias usariam *indiretamente* o seu login). Peça autorização
   por escrito ao seu gerente/canal de correspondentes, e pergunte se existe **API/integração oficial** (é o caminho estável).
   Sem isso, o risco é bloqueio da sua credencial — que paralisa todo o seu negócio.
2. **2FA / CAPTCHA / sessão única.** Se o portal pedir token, SMS ou CAPTCHA, o robô 100% automático não funciona sem tratamento
   específico (e burlar CAPTCHA não é algo que se deva fazer). Também é comum o login aceitar **uma sessão por vez** → por isso `ROBO_CONCURRENCY=1` por padrão.
3. **LGPD.** CPF, renda e nascimento são dados pessoais. Minimize: não logar, não guardar screenshots, definir prazo de retenção
   (ex.: apagar `cliente.*` das propostas após N dias), ter base legal/consentimento do cliente com a imobiliária.

**Campos e seletores do Itaú.** O formulário, o robô (`robot/src/itau/seletores.ts`) e a tela de resultado seguem o HTML real do *Simulador Isolado*
(arquivo salvo pelo parceiro). O portal **simula**: devolve parcelas, taxa e CET, e não "aprovado/recusado" (a aprovação só vem na análise da proposta).
Ainda são placeholders: `login` e `menu` (a página salva não os contém) e as listas **tipo de imóvel, seguradora e sistema de amortização**
(`frontend/opcoes.js`), que o portal carrega por script. Grave-os com `npx playwright codegen <URL>` ou envie prints/HTML dessas telas.

---
## Segurança das credenciais do Itaú (vale para as duas opções)
- Existem **apenas como variáveis de ambiente do servidor que roda o robô** (`ITAU_USUARIO`, `ITAU_SENHA`). Nunca vão para o GitHub,
  para o `firebase-config.js`, para o Firestore, nem para o bundle do Netlify do front.
- Fica no GitHub só o `.env.example` (sem valores). `.env` está no `.gitignore`. Ative **Secret scanning + push protection** no repositório.
- O front nunca recebe credencial nem tem rota que a devolva; o navegador só conversa com Firebase Auth/Firestore.
- Os logs do robô redigem senha/CPF (`logger.ts`). Não envie screenshots de erro ao Firestore.
- Opção 2: use o painel de variáveis da hospedagem (Railway/Render/Fly) ou o **Google Secret Manager** (Cloud Run). Opção 1: variáveis do site no Netlify
  marcadas como **secret** e com escopo "Functions" apenas (nunca em "Builds" do front).
- Papéis (`admin`/`imobiliaria`) ficam em **custom claims** do Firebase Auth, gravadas só por `scripts/definir-papel.mjs` (você, com a service account). O usuário não consegue se auto-promover.

---
## Modelo de dados (Firestore)
```
parceiros/{uid}      { nome, cnpj, email, status: pendente|aprovado, imobiliariaId, criadoEm }
propostas/{id}       { status: pendente|processando|aprovado|recusado|em_analise|erro,
                       corretorUid, imobiliariaId, cliente{cpf,nascimento,rendaBruta,fgts,fgtsValor},
                       operacao{valorImovel,valorFinanciamento,sistema}, resultado{status,valorAprovado,taxaJurosAnual,numeroProposta,motivo},
                       erro{codigo,etapa,mensagemUsuario}, tentativas, worker, travadoEm, criadoEm, concluidoEm }
propostas/{id}/historico/{h}   { status, em, worker?, codigo?, ms? }      // trilha de status
```
Regras em `firebase/firestore.rules`: o corretor só **cria** (status fixo `pendente`) e **lê** as suas; admin lê tudo; ninguém do front atualiza/apaga.
Resultado e status são escritos apenas pelo robô (Admin SDK).

---
## OPÇÃO 1 — Tudo integrado (Netlify Functions rodando o robô)

### Fluxo
1. Corretor loga (Firebase Auth) e preenche o form no Netlify.
2. Front chama `POST /.netlify/functions/iniciar-proposta` com o ID token (`Authorization: Bearer`).
3. A função valida o token/claims, valida o payload (zod), grava `propostas/{id}` com `pendente` e dispara a **background function** (`-background`), respondendo `202`.
4. A background function reivindica a proposta, sobe Chromium (`@sparticuz/chromium`), roda o fluxo e grava `resultado`/`status`.
5. O front, com `onSnapshot` no documento, mostra o resultado assim que o Firestore atualiza.

### Timeout: o Netlify aguenta?
| Tipo | Limite aproximado | Serve? |
|---|---|---|
| Function síncrona | 10 s (até ~26 s sob configuração/plano) | **Não** para Playwright (login + formulário + espera costuma passar disso) |
| **Background function** | **até 15 min** | **Tecnicamente sim** |
Confirme os números atuais na documentação do Netlify e do seu plano. Mesmo com os 15 min, a Opção 1 tem problemas práticos:
- **Chromium em Lambda**: precisa de build enxuto (`@sparticuz/chromium`), memória ~1 GB e *cold start* de vários segundos a cada execução.
- **Sem fila de verdade**: várias propostas = várias execuções paralelas = várias sessões simultâneas na mesma credencial do Itaú (risco de bloqueio/derrubada de sessão). Dá para mitigar com um "lock" no Firestore, mas vira gambiarra.
- **Sem IP fixo** (se o Itaú liberar acesso por IP, não funciona) e difícil depurar (sem navegador visível, sem trace persistente).
- Sem retry/reaper nativos: função morta no meio deixa a proposta em `processando`.
**Veredito:** serve para um *piloto* de baixo volume. Não recomendo para produção.

### Arquivos
`netlify/functions/iniciar-proposta.mts`, `netlify/functions/processar-proposta-background.mts` (reaproveita `robot/src/itau/*`).
Variáveis (Netlify → Site settings → Environment variables, marcadas *secret*, escopo *Functions*): `ITAU_URL_LOGIN`, `ITAU_USUARIO`, `ITAU_SENHA`, `FIREBASE_SERVICE_ACCOUNT_B64`.

---
## OPÇÃO 2 — Híbrida (recomendada): Netlify + Firebase + worker do robô

### Fluxo (o Firestore é a "fila")
1. Corretor loga no site (Netlify) → Firebase Auth devolve o ID token com as claims `role/aprovado/imobiliariaId`.
2. Ao clicar em **Enviar para Análise de Crédito**, o front faz `addDoc(propostas, {status:'pendente', ...})`. As **Regras do Firestore** validam: logado, aprovado, `corretorUid == uid`, `imobiliariaId` da claim, status `pendente`.
3. O front mostra "Analisando…" e abre `onSnapshot` nesse documento.
4. O **worker** (container sempre ligado, `robot/`) tem um listener em `propostas where status=='pendente'`. Ao ver o doc, **reivindica em transação** (`pendente → processando`; dois workers nunca pegam a mesma) e entra numa fila em memória com concorrência limitada (`p-limit`, padrão 1).
5. O robô: abre Chromium headless → login com `.env` → Nova Proposta → preenche → envia → lê status/valor/taxa/nº da proposta → logout → fecha o browser (`finally`).
6. O worker grava `resultado` + `status` + linha em `historico`. O `onSnapshot` do front dispara e a tela de resultado aparece (tipicamente 15–60 s, dependendo do Itaú).
7. Falhas: erros retentáveis (timeout/rede) voltam a `pendente` até `ROBO_MAX_TENTATIVAS`; os demais viram `erro` com código/etapa. Um *reaper* a cada 60 s devolve à fila propostas presas em `processando` (worker que caiu).

### Onde rodar o worker
Qualquer host de container com Node 20: **Railway, Render, Fly.io, Google Cloud Run (min instances = 1)**. Use o `robot/Dockerfile`
(imagem oficial do Playwright, versão fixada = `playwright-core@1.48.2`). Se precisar de IP fixo para o Itaú, Fly.io/VM com IP estático resolvem.
Para escalar sem violar a sessão única, mantenha 1 worker com `ROBO_CONCURRENCY=1`; o gargalo é o Itaú, não o seu servidor.
Observação: Firestore e Auth funcionam no plano gratuito (Spark); o worker não usa Cloud Functions, então não exige plano Blaze.

### Variáveis (só no host do worker — ver `robot/.env.example`)
`ITAU_URL_LOGIN`, `ITAU_USUARIO`, `ITAU_SENHA`, `FIREBASE_SERVICE_ACCOUNT_B64`, `ROBO_CONCURRENCY`, `ROBO_TIMEOUT_MS`, `ROBO_MAX_TENTATIVAS`.

### Redis/BullMQ?
Você restringiu a stack a GitHub/Netlify/Firebase, então a fila é o próprio Firestore (transação de *claim* + `p-limit`). Atende bem até alguns milhares de propostas/dia. Se o volume crescer, troque por Redis+BullMQ mantendo `robot/src/itau/*` intacto.

---
## Estrutura de pastas (GitHub)
```
portal-parceiro/
├─ frontend/                    # publicado no Netlify (publish = frontend)
│  ├─ index.html  app.js  firebase-config.js
├─ firebase/                    # firebase deploy --only firestore
│  ├─ firestore.rules  firestore.indexes.json  firebase.json
├─ robot/                       # OPÇÃO 2 (worker) — também importado pela Opção 1
│  ├─ Dockerfile  .env.example  package.json
│  └─ src/
│     ├─ index.ts  fila.ts  config.ts  logger.ts  types.ts
│     └─ itau/  seletores.ts  login.ts  simulacao.ts  executar.ts  erros.ts  utils.ts
├─ netlify/functions/           # OPÇÃO 1 apenas
│  ├─ iniciar-proposta.mts  processar-proposta-background.mts  package.json
├─ scripts/definir-papel.mjs    # você aprova parceiros / cria admin (custom claims)
├─ netlify.toml
└─ README.md
```

## Passo a passo (Opção 2)
1. Firebase Console: criar projeto → habilitar **Authentication (e-mail/senha)** e **Firestore**; `cd firebase && firebase deploy --only firestore`.
2. Preencher `frontend/firebase-config.js` (config web) e conectar o repositório ao Netlify (base dir `portal-parceiro`, publish `frontend`).
3. Gerar a service account (Configurações → Contas de serviço) → `base64 -w0 serviceAccount.json` → colocar no host do worker.
4. Tornar-se admin: crie sua conta no portal e rode `GOOGLE_APPLICATION_CREDENTIALS=serviceAccount.json node scripts/definir-papel.mjs <seu-uid> admin`.
5. Aprovar imobiliárias: `node scripts/definir-papel.mjs <uid> imobiliaria <imobiliariaId>` (adicione `gestor` ao final para ver as propostas de toda a imobiliária).
6. Deploy do worker (`robot/Dockerfile`) com as variáveis; ajuste os seletores com `playwright codegen`; teste com `HEADLESS=false` localmente.

## Pendências conhecidas (não implementadas neste esqueleto)
- Painel do administrador (listar imobiliárias/corretores/propostas): as regras já permitem leitura total ao `admin`; falta só a tela.
- Rate limit por imobiliária (ex.: máx. N propostas/min) e App Check do Firebase contra abuso.
- Rotina de retenção/limpeza de dados pessoais (LGPD).
- Testes do robô contra um HTML simulado do portal (mock) para CI.
