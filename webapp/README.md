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

- Backend: Node.js + TypeScript, Express (REST) + `ws` (WebSocket), SQLite (`better-sqlite3`), Vitest.
- Frontend: React + TypeScript + Vite + Tailwind (ainda nao implementado — proxima etapa).
- Pacote compartilhado (`shared/`): tipos de dominio e a regra "12 Candles" congelada.

## Estrutura (monorepo com npm workspaces)

```
webapp/
  shared/   tipos + regra 12 Candles (sem logica de servidor)
  server/   API + WebSocket + banco + StrategyEngine + BrokerAdapter
  client/   frontend (proxima etapa)
```

## Instalar e rodar

```bash
npm install
npm run dev
```

Isso sobe o servidor (`server/src/index.ts`) em `http://localhost:4000`, com endpoints
`/api/health`, `/api/settings` (GET/PUT), `/api/backtest` (POST) e `/api/events`, alem de
WebSocket em `/ws` (transmite os eventos do monitor ao vivo). O banco SQLite e criado
automaticamente em `server/data/app.db` na primeira execucao. Sem nenhuma configuracao
extra, usa `MockBrokerAdapter` (sem rede) — para rodar contra a Polarium de verdade, ver
`.env.example`.

Copie `server/.env.example` para `server/.env` e ajuste conforme necessario
(`POLARIUM_SSID` **nunca** deve ser commitado).

## Rodar os testes

```bash
npm test
```

## O que ja existe (Fases 1-4 do plano)

1. **Arquitetura + banco** — schema SQLite (`server/src/db/schema.sql`) cobrindo candles,
   sinais, ordens, backtests/ocorrencias, configuracoes, resultado diario e eventos.
   Protecao contra ordem duplicada (`UNIQUE(signal_id)`) testada em
   `server/test/orderDedup.spec.ts`.
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

## O que ainda falta (proximas etapas, na ordem combinada)

5. Frontend (Vite + React + Tailwind): paginas Monitor, Validacao 30D, Operacoes, Logs, Configuracoes.
6. Mini-candles reais (corpo + pavio) no Monitor ao vivo, consumindo o WebSocket ja existente.
7. Integracao Polarium somente leitura validada em producao (candles ao vivo reais).
8. Modo DEMO: SafetyGate (checklist de seguranca) + OrderService ligando PATTERN_CONFIRMED a `placeOrder`, na conta de pratica da Polarium.
9. Modo REAL — permanece bloqueado.

## Seguranca (recapitulando o que ja esta implementado ou reservado no design)

- SSID somente via variavel de ambiente, nunca hardcoded, nunca logado.
- Ordem so pode ser criada se nao existir uma ordem previa para o mesmo `signalId`
  (garantido pelo schema do banco, nao so pelo codigo da aplicacao).
- `BrokerAdapter.getPayout()` retorna `null` quando a corretora nao informa um payout
  confiavel — os chamadores devem tratar isso como "nao operar".
- Nenhum metodo do `PolariumAdapter` inventa comportamento: onde a confirmacao real ainda
  falta, o codigo lanca erro/`TODO` em vez de assumir.
