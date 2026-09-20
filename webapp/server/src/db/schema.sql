-- Esquema SQLite. Todas as tabelas usam CREATE TABLE IF NOT EXISTS para permitir
-- reinicio seguro da aplicacao sem perder dados (requisito: "reinicio da aplicacao").

CREATE TABLE IF NOT EXISTS candles (
  active_id INTEGER NOT NULL,
  size INTEGER NOT NULL,
  from_ts INTEGER NOT NULL,
  to_ts INTEGER NOT NULL,
  open REAL NOT NULL,
  high REAL NOT NULL,
  low REAL NOT NULL,
  close REAL NOT NULL,
  is_closed INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL, -- 'live' | 'backtest' | 'mock'
  created_at INTEGER NOT NULL,
  PRIMARY KEY (active_id, size, from_ts, source)
);

CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY, -- 12CANDLES-{activeId}-{ts12}-CALL — garante 1 sinal por (ativo, vela 12, direcao)
  active_id INTEGER NOT NULL,
  direction TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  pattern_json TEXT NOT NULL, -- as 12 velas (Candle[])
  wick_percentage_11 REAL NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  signal_id TEXT NOT NULL UNIQUE REFERENCES signals(id), -- protecao: no maximo 1 ordem por sinal
  broker_order_id TEXT,
  active_id INTEGER NOT NULL,
  direction TEXT NOT NULL,
  amount REAL NOT NULL,
  status TEXT NOT NULL,
  requested_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  resolved_at INTEGER,
  result TEXT,
  payout_percentage REAL,
  pnl REAL,
  mode TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backtests (
  id TEXT PRIMARY KEY,
  active_ids_json TEXT NOT NULL,
  days INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS backtest_occurrences (
  id TEXT PRIMARY KEY,
  backtest_id TEXT NOT NULL REFERENCES backtests(id),
  active_id INTEGER NOT NULL,
  occurred_at INTEGER NOT NULL,
  candles_json TEXT NOT NULL, -- as 12 velas
  wick_percentage_11 REAL NOT NULL,
  candle13_json TEXT, -- pode ser NULL se nao houver dado suficiente
  result TEXT, -- WIN | LOSS | DOJI | NULL (sem candle13)
  is_first_of_day INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_results (
  date TEXT PRIMARY KEY, -- YYYY-MM-DD UTC
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  dojis INTEGER NOT NULL DEFAULT 0,
  pnl REAL NOT NULL DEFAULT 0,
  operations_count INTEGER NOT NULL DEFAULT 0,
  stop_win_hit INTEGER NOT NULL DEFAULT 0,
  stop_loss_hit INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  active_id INTEGER,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_candles_active_size_from ON candles (active_id, size, from_ts);
CREATE INDEX IF NOT EXISTS idx_events_type_created ON events (type, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_active ON orders (active_id);
CREATE INDEX IF NOT EXISTS idx_backtest_occ_backtest ON backtest_occurrences (backtest_id);
