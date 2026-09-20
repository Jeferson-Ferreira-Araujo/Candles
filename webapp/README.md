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
`/api/health` e `/api/settings`, e WebSocket em `/ws`. O banco SQLite e criado
automaticamente em `server/data/app.db` na primeira execucao.

Copie `server/.env.example` para `server/.env` e ajuste conforme necessario
(`POLARIUM_SSID` **nunca** deve ser commitado).

## Rodar os testes

```bash
npm test
```

## O que ja existe (Fases 1-2 do plano)

1. **Arquitetura + banco** — schema SQLite (`server/src/db/schema.sql`) cobrindo candles,
   sinais, ordens, backtests/ocorrencias, configuracoes, resultado diario e eventos.
   Protecao contra ordem duplicada (`UNIQUE(signal_id)`) testada em
   `server/test/orderDedup.spec.ts`.
2. **StrategyEngine "12 Candles"** (`server/src/strategy/twelveCandlesEngine.ts`) — regra
   congelada, com suporte a padroes sobrepostos, invalidacao pelo pavio da 11a vela
   (incluindo o caso `high === low`), e deteccao de gaps. Coberto por
   `server/test/twelveCandlesEngine.spec.ts` (9 casos, incluindo os limites 24.99%/25%).
3. **BrokerAdapter** (`server/src/broker/BrokerAdapter.ts`) — interface unica; duas
   implementacoes:
   - `MockBrokerAdapter`: funcional, sem rede, com replay de candles (usado em testes e no
     backtest/desenvolvimento).
   - `PolariumAdapter`: construido **somente** com metodos confirmados lendo o
     codigo-fonte do SDK instalado (`@quadcode-tech/client-sdk-js`). Onde algo ainda nao
     foi confirmado (ex.: leitura de posicoes ja fechadas via historico), o codigo deixa um
     `TODO(confirmar)` explicito em vez de inventar comportamento.

## O que ainda falta (proximas etapas, na ordem combinada)

3. Backtest 30D (contagem de ocorrencias por dia/ativo, WIN/LOSS/DOJI, primeira ocorrencia do dia).
4. MockBroker com replay completo de candles historicos (para rodar o backtest e o Monitor sem rede).
5. Frontend (Vite + React + Tailwind): paginas Monitor, Validacao 30D, Operacoes, Logs, Configuracoes.
6. Monitor ao vivo com mini-candles reais e WebSocket.
7. Integracao Polarium somente leitura (candles ao vivo).
8. Modo DEMO (ordens reais na conta de pratica da Polarium).
9. Modo REAL — permanece bloqueado.

## Seguranca (recapitulando o que ja esta implementado ou reservado no design)

- SSID somente via variavel de ambiente, nunca hardcoded, nunca logado.
- Ordem so pode ser criada se nao existir uma ordem previa para o mesmo `signalId`
  (garantido pelo schema do banco, nao so pelo codigo da aplicacao).
- `BrokerAdapter.getPayout()` retorna `null` quando a corretora nao informa um payout
  confiavel — os chamadores devem tratar isso como "nao operar".
- Nenhum metodo do `PolariumAdapter` inventa comportamento: onde a confirmacao real ainda
  falta, o codigo lanca erro/`TODO` em vez de assumir.
