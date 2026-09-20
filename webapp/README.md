# Polarium 12 Candles — Monitor (em construcao por etapas)

Aplicacao full-stack para **monitorar** (e, futuramente, semi-automatizar em conta DEMO)
a estrategia "12 Candles" na Polarium/Quadcode. **Modo REAL fica bloqueado** ate ser
explicitamente destravado no futuro. Nenhuma parte desta aplicacao decide se a estrategia
"e boa" — ela so implementa a regra exatamente como foi congelada.

⚠️ **Aviso honesto:** o historico de desenvolvimento (14/14) e uma amostra pequena demais
para provar qualquer vantagem estatistica, e o payout de opcoes digitais/binarias favorece
estruturalmente a corretora no agregado. A interface deve sempre comunicar isso — nunca
"garantido".

## Stack

- Backend: Node.js + TypeScript, Express (REST) + `ws` (WebSocket), Postgres via Supabase (`pg`), Vitest.
- Frontend: React + TypeScript + Vite + Tailwind.
- Pacote compartilhado (`shared/`): tipos de dominio e a regra "12 Candles" congelada.

## Estrutura (monorepo com npm workspaces)

```
webapp/
  shared/   tipos + regra 12 Candles (sem logica de servidor)
  server/   API + WebSocket + banco + StrategyEngine + BrokerAdapter
  client/   frontend (Vite + React + Tailwind)
```

## Instalar e rodar

Backend (porta 4000):

```bash
npm install
npm run dev
```

Isso sobe o servidor (`server/src/index.ts`) em `http://localhost:4000`, com endpoints
`/api/health`, `/api/settings` (GET/PUT), `/api/backtest` (POST), `/api/events`,
`/api/daily-result` e `/api/balances`, alem de WebSocket em `/ws` (transmite os eventos do
monitor ao vivo). Sem nenhuma configuracao extra, usa `MockBrokerAdapter` (sem rede) — para
rodar contra a Polarium de verdade, ver `.env.example`.

Frontend (porta 5173, em outro terminal — proxy `/api` e `/ws` ja apontam para o backend):

```bash
npm run dev:client
```

Copie `server/.env.example` para `server/.env` e ajuste conforme necessario —
**`DATABASE_URL` e obrigatorio** mesmo em modo mock (o servidor nao sobe sem ele). Veja a
secao **Banco de dados (Supabase)** abaixo para onde pegar essa connection string.

### Login (modo `polarium`)

Quando `BROKER_ADAPTER=polarium`, o app fica **fechado por login**: toda rota de API exige
uma sessao valida, e a sessao so nasce depois de um `POST /api/auth/login` com um SSID que
a Polarium aceite. O frontend mostra uma tela de login pedindo o SSID (não a senha — o SDK
oficial nao tem nenhum metodo de login por email/senha) assim que detecta que o backend
exige autenticacao (`GET /api/auth/status`). Nada e salvo em disco: o SSID so vive na
memoria do processo do servidor enquanto ele estiver de pe; reiniciar o servidor exige
logar de novo. Em `BROKER_ADAPTER=mock` (padrao local) o login e pulado inteiramente.

## Banco de dados (Supabase)

O banco e Postgres hospedado no [Supabase](https://supabase.com) (projeto `candles-12`) —
nao SQLite local. O schema (`server/src/db/schema.sql`, `CREATE TABLE IF NOT EXISTS`) e
aplicado automaticamente toda vez que o servidor sobe, contra qualquer Postgres que voce
apontar via `DATABASE_URL`.

Para pegar a connection string: painel do Supabase → projeto `candles-12` → **Project
Settings** → **Database** → **Connection String** → aba **URI**. Cole em
`server/.env` como `DATABASE_URL=...` — **nunca cole a senha no chat ou em qualquer lugar
versionado**.

Os testes (`npm test`) usam o MESMO banco (nao ha um modo ":memory:" para Postgres) —
cada teste limpa (`TRUNCATE`) as tabelas relevantes antes de rodar, e os arquivos de teste
rodam em sequencia (nao em paralelo) para nao haver corrida entre eles. Por isso rodar os
testes localmente tambem exige `DATABASE_URL` configurado em `server/.env`.

## Rodar os testes

```bash
npm test
```

## O que ja existe (Fases 1-5 e 8 do plano)

1. **Arquitetura + banco** — schema Postgres (`server/src/db/schema.sql`, ver secao
   **Banco de dados** acima) cobrindo candles, sinais, ordens, backtests/ocorrencias,
   configuracoes, resultado diario e eventos. Protecao contra ordem duplicada
   (`UNIQUE(signal_id)`) testada em `server/test/orderDedup.spec.ts`.
2. **StrategyEngine "12 Candles"** (`server/src/strategy/twelveCandlesEngine.ts`) — regra
   congelada, com suporte a padroes sobrepostos, invalidacao pelo pavio da 11a vela
   (incluindo o caso `high === low`), e deteccao de gaps. Coberto por
   `server/test/twelveCandlesEngine.spec.ts` (9 casos, incluindo os limites 24.99%/25%).
3. **Backtest 30D** (`server/src/backtest/backtestRunner.ts`) — roda o StrategyEngine sobre
   o historico M1 de qualquer lista de ativos, registra TODAS as ocorrencias (com as 12
   velas, pavio da 11a, OHLC da 13a e resultado WIN/LOSS/DOJI), separa o resultado de
   "todas as ocorrencias" do resultado "so a primeira ocorrencia de cada dia" (a mais
   antiga do dia, entre todos os ativos combinados), e monta a tabela dia-a-dia por ativo
   (incluindo dias com zero sinais). Endpoint: `POST /api/backtest { activeIds, days }`.
   Testado em `server/test/backtestRunner.spec.ts`.
4. **Live monitor + MockBroker com replay** (`server/src/live/LiveMonitorService.ts`) —
   liga qualquer `BrokerAdapter` ao StrategyEngine via `subscribeCandles`: candles fechados
   alimentam o motor e sao persistidos; candles ainda abertos so geram o preview do pavio
   da 11a (nunca confirmam nada). Emite `CANDLE_CLOSED` / `PATTERN_PROGRESS` /
   `PATTERN_CONFIRMED` / `PATTERN_INVALIDATED`, persistidos na tabela `events` e
   retransmitidos por WebSocket (`/ws`) para quem estiver conectado.
   `MockBrokerAdapter.pushLiveCandle()` permite testar esse fluxo inteiro (fechamento →
   progresso → confirmacao) sem nenhuma rede real — testado em
   `server/test/liveMonitorService.spec.ts`.
5. **BrokerAdapter** (`server/src/broker/BrokerAdapter.ts`) — interface unica; duas
   implementacoes:
   - `MockBrokerAdapter`: funcional, sem rede, com replay de candles (usado em testes e no
     backtest/desenvolvimento).
   - `PolariumAdapter`: construido **somente** com metodos confirmados lendo o
     codigo-fonte do SDK instalado (`@quadcode-tech/client-sdk-js`). Onde algo ainda nao
     foi confirmado (ex.: leitura de posicoes ja fechadas via historico), o codigo deixa um
     `TODO(confirmar)` explicito em vez de inventar comportamento.
   - Escolhida via `BROKER_ADAPTER=mock|polarium` (`.env`) atraves de `brokerFactory.ts` —
     padrao `mock`, nunca conecta em nada real sem configuracao explicita.

5. **Frontend** (`client/`) — 5 paginas com React Router (Monitor, Validacao 30D,
   Operacoes, Configuracoes, Logs), layout com cabecalho (conexao/modo/robô/saldo/
   resultado do dia/operacoes hoje + botao "Parar robô", que persiste um kill switch em
   `Settings.robotActive` e registra `KILL_SWITCH`), sidebar de navegacao, cards de padrao
   por ativo com mini-candles SVG reais (corpo + pavio, nao so circulos) mostrando as velas
   ja casadas e slots vazios pontilhados para as que faltam, barra de progresso do pavio da
   11a em tempo real, feed de eventos via WebSocket, formulario de configuracoes completo
   (entrada minima R$5, gale no maximo 1 nivel, stops diarios, ativos monitorados) e a
   pagina de backtest com a tabela dia-a-dia por ativo. Layout visual usado como base:
   captura de tela fornecida pelo usuario (dark theme, cards de estado MONITORANDO/
   ACOMPANHANDO/ATENCAO/PRE-SINAL/CONFIRMADO). Nenhum numero e fixo/mockado — tudo vem de
   `/api/*` e do WebSocket; estados vazios aparecem honestamente como "—"/"nenhum ainda".
6. **SafetyGate** (`server/src/orders/SafetyGate.ts`, funcao pura, 17 testes) — checklist
   completo antes de qualquer ordem: sinal duplicado, modo (so opera em DEMO — OBSERVATION
   nunca envia, REAL nunca e permitido nesta versao), kill switch (`robotActive`), conexao/
   sessao (via `getServerTime()`), sincronismo de horario (tolerancia configuravel),
   saldo conhecido, **payout conhecido** (nunca inventado — bloqueia se `getPayout()`
   retornar `null`), valor minimo/saldo suficiente, Stop Win diario, Stop Loss diario,
   maximo de operacoes/dia, e ordem pendente no mesmo ativo. Qualquer campo desconhecido
   bloqueia (nunca assume "seguro"). Acumula TODOS os motivos de bloqueio, nao so o primeiro.
7. **OrderService** (`server/src/orders/OrderService.ts`, 6 testes de integracao via
   `MockBrokerAdapter`) — ouve `PATTERN_CONFIRMED`, roda o SafetyGate, e so entao persiste a
   ordem (`INSERT` protegido por `UNIQUE(signal_id)`) **antes** de chamar
   `broker.placeOrder()`. Se a chamada falhar/cair a conexao depois de persistir e antes de
   confirmar, a ordem fica `UNKNOWN` — nunca reenviada. Resolve o resultado via polling de
   `getOrderResult()`, atualiza `daily_results` (WIN/LOSS/DOJI, PnL, contagem) e dispara
   eventos `STOP_WIN`/`STOP_LOSS` quando os limites diarios sao atingidos. Reconciliacao de
   ordens `UNKNOWN` com `brokerOrderId` conhecido roda na subida do servidor
   (`reconcileUnknownOrders` em `index.ts`). Pagina **Operacoes** agora mostra as ordens
   reais (`GET /api/orders`), sem nenhum dado inventado.
8. Modo REAL — permanece bloqueado (a UI ja desabilita a opcao, e o SafetyGate bloqueia
   incondicionalmente mesmo que a opcao seja forcada por outro caminho).

## O que ainda falta

- Integracao Polarium somente leitura validada em producao (todo o fluxo acima so foi
  testado de ponta a ponta contra o `MockBrokerAdapter`; falta confirmar com uma sessao
  real — `BROKER_ADAPTER=polarium` + `POLARIUM_SSID`).
- Reiniciar o monitor ao vivo (e o `OrderService`) automaticamente quando
  `selectedActiveIds` mudar nas configuracoes, sem precisar reiniciar o servidor (hoje isso
  so e lido na subida do processo).
- Confirmar `Positions.getPositionsHistory()` no `PolariumAdapter` para reconciliar posicoes
  ja fechadas (hoje reportado como `UNKNOWN` em vez de assumido).
- Gale (a config existe e valida "no maximo 1 nivel", mas o `OrderService` ainda nao
  implementa a logica de reentrada apos LOSS — so faz a entrada original).

## Seguranca (recapitulando o que ja esta implementado ou reservado no design)

- SSID nunca fica em variavel de ambiente fixa nem em arquivo — so entra pela tela de
  login, fica em memoria do servidor, nunca e logado no console.
- Todas as rotas de API (exceto `/api/health` e `/api/auth/*`) exigem sessao valida quando
  `BROKER_ADAPTER=polarium` — sem isso, nao ha como consultar nada nem enviar ordem.
- Ordem so pode ser criada se nao existir uma ordem previa para o mesmo `signalId`
  (garantido pelo schema do banco, nao so pelo codigo da aplicacao).
- `BrokerAdapter.getPayout()` retorna `null` quando a corretora nao informa um payout
  confiavel — os chamadores devem tratar isso como "nao operar".
- Nenhum metodo do `PolariumAdapter` inventa comportamento: onde a confirmacao real ainda
  falta, o codigo lanca erro/`TODO` em vez de assumir.

## Deploy

Este app tem duas partes com necessidades muito diferentes de hospedagem:

- **`client/`** (Vite/React) — arquivos estaticos. Serve bem em qualquer CDN, inclusive
  **Vercel**.
- **`server/`** (Express + WebSocket persistente) — precisa de um processo Node de longa
  duracao. **Isso NAO roda em serverless da Vercel** (funcoes serverless sao stateless, com
  timeout curto, e sem WebSocket persistente do jeito que este app usa). Por isso o backend
  vai no **Render**, falando com o Postgres do **Supabase** (ja nao depende mais de disco
  local para persistir dados).

### Backend no Render

1. No painel do Render: **New +** → **Blueprint** → conecte o repositorio GitHub. O Render
   le o `render.yaml` da raiz do repositorio sozinho e cria o servico `candles-12-server`.
2. Em **Environment**, preencha as variaveis marcadas como secretas no blueprint:
   - `DATABASE_URL` — connection string do Postgres (Supabase, projeto `candles-12`; ver
     secao **Banco de dados** acima para onde pegar).
   - `POLARIUM_PLATFORM_ID` (82, salvo indicacao em contrario)
   - `CORS_ORIGIN` — a URL do seu frontend na Vercel (ex.: `https://seu-app.vercel.app`),
     **sem barra no final**. Sem isso, o navegador bloqueia as chamadas por CORS.
3. **Nunca** adicione `POLARIUM_SSID` como variavel de ambiente — ele so entra pela tela
   de login em tempo de execucao.
4. Depois do primeiro deploy, anote a URL publica do servico (ex.:
   `https://candles-12-server.onrender.com`) — voce vai precisar dela no passo da Vercel.

### Frontend na Vercel

1. **New Project** → importe o mesmo repositorio GitHub.
2. Em **Root Directory**, selecione `webapp/client`.
3. Em **Environment Variables**, adicione `VITE_API_BASE_URL` com a URL do backend no
   Render (do passo anterior), **sem barra no final**.
4. Deploy. A Vercel detecta o monorepo (via `workspaces` no `package.json` raiz) e builda
   `shared` automaticamente antes do `client` (`postinstall` cuida disso).

### Depois do deploy

Acesse a URL da Vercel → tela de login → cole o SSID atual da sua sessao Polarium (mesmo
processo de sempre, via DevTools do navegador). A sessao dura 12h ou ate voce clicar em
"Sair"; se o Render reiniciar o processo (redeploy, sleep no plano free, etc.), sera
preciso logar de novo.
