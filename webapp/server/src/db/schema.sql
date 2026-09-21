-- Esquema Postgres (Supabase). Todas as tabelas usam CREATE TABLE IF NOT EXISTS para
-- permitir reinicio seguro da aplicacao sem perder dados (requisito: "reinicio da
-- aplicacao"). Este arquivo e a fonte da verdade — a mesma migration foi aplicada
-- diretamente no projeto Supabase (candles-12) via MCP.

CREATE TABLE IF NOT EXISTS candles (
  active_id BIGINT NOT NULL,
  size INTEGER NOT NULL,
  from_ts BIGINT NOT NULL,
  to_ts BIGINT NOT NULL,
  open DOUBLE PRECISION NOT NULL,
  high DOUBLE PRECISION NOT NULL,
  low DOUBLE PRECISION NOT NULL,
  close DOUBLE PRECISION NOT NULL,
  is_closed BOOLEAN NOT NULL DEFAULT TRUE,
  source TEXT NOT NULL, -- 'live' | 'backtest' | 'mock'
  created_at BIGINT NOT NULL,
  PRIMARY KEY (active_id, size, from_ts, source)
);

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY, -- 12CANDLES-{activeId}-{ts12}-CALL — garante 1 sinal por (ativo, vela 12, direcao)
  active_id BIGINT NOT NULL,
  direction TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  pattern_json JSONB NOT NULL, -- as 12 velas (Candle[])
  wick_percentage_11 DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  signal_id TEXT NOT NULL UNIQUE REFERENCES signals(id), -- protecao: no maximo 1 ordem por sinal
  broker_order_id TEXT,
  active_id BIGINT NOT NULL,
  direction TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL,
  requested_at BIGINT NOT NULL,
  confirmed_at BIGINT,
  resolved_at BIGINT,
  result TEXT,
  payout_percentage DOUBLE PRECISION,
  pnl DOUBLE PRECISION,
  mode TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backtests (
  id TEXT PRIMARY KEY,
  active_ids_json JSONB NOT NULL,
  days INTEGER NOT NULL,
  started_at BIGINT NOT NULL,
  finished_at BIGINT
);

CREATE TABLE IF NOT EXISTS backtest_occurrences (
  id TEXT PRIMARY KEY,
  backtest_id TEXT NOT NULL REFERENCES backtests(id),
  active_id BIGINT NOT NULL,
  occurred_at BIGINT NOT NULL,
  candles_json JSONB NOT NULL, -- as 12 velas
  wick_percentage_11 DOUBLE PRECISION NOT NULL,
  candle13_json JSONB, -- pode ser NULL se nao houver dado suficiente
  result TEXT, -- WIN | LOSS | DOJI | NULL (sem candle13)
  is_first_of_day BOOLEAN NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json JSONB NOT NULL
);

-- Padroes de candles definidos pelo usuario na tela de edicao de padrao, substituindo a
-- antiga regra fixa no codigo. candles_json guarda todas as casas preenchidas (CandleColor[]),
-- da mais antiga para a mais nova — a ultima e a vela de entrada, cuja cor define a direcao.
CREATE TABLE IF NOT EXISTS custom_patterns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  candles_json JSONB NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT FALSE,
  created_at BIGINT NOT NULL
);

-- Garante no maximo 1 padrao ativo por vez (o monitor ao vivo sempre usa um so).
CREATE UNIQUE INDEX IF NOT EXISTS idx_custom_patterns_single_active ON custom_patterns (is_active) WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS daily_results (
  date TEXT PRIMARY KEY, -- YYYY-MM-DD UTC
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  dojis INTEGER NOT NULL DEFAULT 0,
  pnl DOUBLE PRECISION NOT NULL DEFAULT 0,
  operations_count INTEGER NOT NULL DEFAULT 0,
  stop_win_hit BOOLEAN NOT NULL DEFAULT FALSE,
  stop_loss_hit BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  active_id BIGINT,
  payload_json JSONB NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_candles_active_size_from ON candles (active_id, size, from_ts);
CREATE INDEX IF NOT EXISTS idx_events_type_created ON events (type, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_active ON orders (active_id);
CREATE INDEX IF NOT EXISTS idx_backtest_occ_backtest ON backtest_occurrences (backtest_id);
