import type Database from 'better-sqlite3';
import type {
  AppEvent,
  BacktestRun,
  Candle,
  DailyResult,
  OrderRecord,
  PatternOccurrence,
  Settings,
  Signal,
} from '@polarium12c/shared';
import { DEFAULT_SETTINGS } from '@polarium12c/shared';

/**
 * Repositorios finos sobre better-sqlite3. Sem ORM: as queries sao explicitas e
 * pequenas o suficiente para revisar a olho — importante para um app que decide
 * sozinho quando enviar ordens.
 */

export type CandleSource = 'live' | 'backtest' | 'mock';

export function saveCandle(db: Database.Database, c: Candle, source: CandleSource): void {
  db.prepare(
    `INSERT INTO candles (active_id, size, from_ts, to_ts, open, high, low, close, is_closed, source, created_at)
     VALUES (@activeId, @size, @from, @to, @open, @high, @low, @close, @isClosed, @source, @createdAt)
     ON CONFLICT(active_id, size, from_ts, source) DO UPDATE SET
       to_ts = excluded.to_ts, open = excluded.open, high = excluded.high, low = excluded.low,
       close = excluded.close, is_closed = excluded.is_closed`
  ).run({
    activeId: c.activeId,
    size: c.size,
    from: c.from,
    to: c.to,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    isClosed: c.isClosed ? 1 : 0,
    source,
    createdAt: Date.now(),
  });
}

export function getCandles(
  db: Database.Database,
  activeId: number,
  size: number,
  source: CandleSource,
  limit = 500
): Candle[] {
  const rows = db
    .prepare(
      `SELECT active_id as activeId, size, from_ts as "from", to_ts as "to", open, high, low, close, is_closed as isClosed
       FROM candles WHERE active_id = ? AND size = ? AND source = ? ORDER BY from_ts DESC LIMIT ?`
    )
    .all(activeId, size, source, limit) as Array<Omit<Candle, 'isClosed'> & { isClosed: number }>;
  return rows.map((r) => ({ ...r, isClosed: !!r.isClosed })).reverse();
}

function serializeCandles(candles: Candle[]): string {
  return JSON.stringify(candles);
}

function deserializeCandles(json: string): Candle[] {
  return JSON.parse(json) as Candle[];
}

export function saveSignal(db: Database.Database, s: Signal): void {
  db.prepare(
    `INSERT INTO signals (id, active_id, direction, created_at, pattern_json, wick_percentage_11, status)
     VALUES (@id, @activeId, @direction, @createdAt, @patternJson, @wick, @status)`
  ).run({
    id: s.id,
    activeId: s.activeId,
    direction: s.direction,
    createdAt: s.createdAt,
    patternJson: serializeCandles(s.candles),
    wick: s.wickPercentage11,
    status: s.status,
  });
}

export function getSignal(db: Database.Database, id: string): Signal | undefined {
  const row = db.prepare(`SELECT * FROM signals WHERE id = ?`).get(id) as
    | {
        id: string;
        active_id: number;
        direction: string;
        created_at: number;
        pattern_json: string;
        wick_percentage_11: number;
        status: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    activeId: row.active_id,
    direction: row.direction as Signal['direction'],
    createdAt: row.created_at,
    candles: deserializeCandles(row.pattern_json),
    wickPercentage11: row.wick_percentage_11,
    status: row.status as Signal['status'],
  };
}

export function updateSignalStatus(db: Database.Database, id: string, status: Signal['status']): void {
  db.prepare(`UPDATE signals SET status = ? WHERE id = ?`).run(status, id);
}

/**
 * Insere a ordem SOMENTE se ainda nao existir uma ordem para este signal_id (protecao
 * persistida contra ordem duplicada, exigida pela regra de seguranca). Retorna a ordem
 * que ficou registrada (a que acabou de ser inserida, ou a existente se ja havia uma).
 */
export function insertOrderIfAbsent(db: Database.Database, o: OrderRecord): { inserted: boolean; order: OrderRecord } {
  const existing = getOrderBySignalId(db, o.signalId);
  if (existing) return { inserted: false, order: existing };

  db.prepare(
    `INSERT INTO orders (id, signal_id, broker_order_id, active_id, direction, amount, status, requested_at, confirmed_at, resolved_at, result, payout_percentage, pnl, mode)
     VALUES (@id, @signalId, @brokerOrderId, @activeId, @direction, @amount, @status, @requestedAt, @confirmedAt, @resolvedAt, @result, @payoutPercentage, @pnl, @mode)`
  ).run({
    id: o.id,
    signalId: o.signalId,
    brokerOrderId: o.brokerOrderId ?? null,
    activeId: o.activeId,
    direction: o.direction,
    amount: o.amount,
    status: o.status,
    requestedAt: o.requestedAt,
    confirmedAt: o.confirmedAt ?? null,
    resolvedAt: o.resolvedAt ?? null,
    result: o.result ?? null,
    payoutPercentage: o.payoutPercentage ?? null,
    pnl: o.pnl ?? null,
    mode: o.mode,
  });
  return { inserted: true, order: o };
}

function rowToOrder(row: Record<string, unknown>): OrderRecord {
  return {
    id: row.id as string,
    signalId: row.signal_id as string,
    brokerOrderId: (row.broker_order_id as string | null) ?? undefined,
    activeId: row.active_id as number,
    direction: row.direction as OrderRecord['direction'],
    amount: row.amount as number,
    status: row.status as OrderRecord['status'],
    requestedAt: row.requested_at as number,
    confirmedAt: (row.confirmed_at as number | null) ?? undefined,
    resolvedAt: (row.resolved_at as number | null) ?? undefined,
    result: (row.result as OrderRecord['result'] | null) ?? undefined,
    payoutPercentage: (row.payout_percentage as number | null) ?? undefined,
    pnl: (row.pnl as number | null) ?? undefined,
    mode: row.mode as OrderRecord['mode'],
  };
}

export function getOrderBySignalId(db: Database.Database, signalId: string): OrderRecord | undefined {
  const row = db.prepare(`SELECT * FROM orders WHERE signal_id = ?`).get(signalId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToOrder(row) : undefined;
}

export function updateOrder(db: Database.Database, id: string, patch: Partial<OrderRecord>): void {
  const current = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!current) throw new Error(`Order ${id} nao encontrada`);
  const merged = { ...rowToOrder(current), ...patch };
  db.prepare(
    `UPDATE orders SET broker_order_id=@brokerOrderId, status=@status, confirmed_at=@confirmedAt,
     resolved_at=@resolvedAt, result=@result, payout_percentage=@payoutPercentage, pnl=@pnl WHERE id=@id`
  ).run({
    id,
    brokerOrderId: merged.brokerOrderId ?? null,
    status: merged.status,
    confirmedAt: merged.confirmedAt ?? null,
    resolvedAt: merged.resolvedAt ?? null,
    result: merged.result ?? null,
    payoutPercentage: merged.payoutPercentage ?? null,
    pnl: merged.pnl ?? null,
  });
}

export function listUnknownOrders(db: Database.Database): OrderRecord[] {
  const rows = db.prepare(`SELECT * FROM orders WHERE status = 'UNKNOWN'`).all() as Array<Record<string, unknown>>;
  return rows.map(rowToOrder);
}

export function listOrders(db: Database.Database, limit = 200): OrderRecord[] {
  const rows = db.prepare(`SELECT * FROM orders ORDER BY requested_at DESC LIMIT ?`).all(limit) as Array<Record<string, unknown>>;
  return rows.map(rowToOrder);
}

/** True se existe alguma ordem para este ativo ainda sem resultado (aberta ou de status desconhecido). */
export function hasPendingOrderForActive(db: Database.Database, activeId: number): boolean {
  const row = db
    .prepare(
      `SELECT COUNT(*) as n FROM orders WHERE active_id = ? AND status IN ('REQUESTED', 'CONFIRMED', 'UNKNOWN')`
    )
    .get(activeId) as { n: number };
  return row.n > 0;
}

export function insertEvent(db: Database.Database, e: AppEvent): void {
  db.prepare(`INSERT INTO events (id, type, active_id, payload_json, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    e.id,
    e.type,
    e.activeId ?? null,
    JSON.stringify(e.payload),
    e.createdAt
  );
}

export function listEvents(db: Database.Database, limit = 200): AppEvent[] {
  const rows = db
    .prepare(`SELECT * FROM events ORDER BY created_at DESC LIMIT ?`)
    .all(limit) as Array<{ id: string; type: string; active_id: number | null; payload_json: string; created_at: number }>;
  return rows.map((r) => ({
    id: r.id,
    type: r.type as AppEvent['type'],
    activeId: r.active_id ?? undefined,
    payload: JSON.parse(r.payload_json),
    createdAt: r.created_at,
  }));
}

export function loadSettings(db: Database.Database): Settings {
  const row = db.prepare(`SELECT value_json FROM settings WHERE key = 'settings'`).get() as
    | { value_json: string }
    | undefined;
  if (!row) return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...(JSON.parse(row.value_json) as Partial<Settings>) };
}

export function saveSettings(db: Database.Database, settings: Settings): void {
  db.prepare(
    `INSERT INTO settings (key, value_json) VALUES ('settings', ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`
  ).run(JSON.stringify(settings));
}

export function getDailyResult(db: Database.Database, date: string): DailyResult {
  const row = db.prepare(`SELECT * FROM daily_results WHERE date = ?`).get(date) as
    | {
        date: string;
        wins: number;
        losses: number;
        dojis: number;
        pnl: number;
        operations_count: number;
        stop_win_hit: number;
        stop_loss_hit: number;
      }
    | undefined;
  if (!row) {
    return { date, wins: 0, losses: 0, dojis: 0, pnl: 0, operationsCount: 0, stopWinHit: false, stopLossHit: false };
  }
  return {
    date: row.date,
    wins: row.wins,
    losses: row.losses,
    dojis: row.dojis,
    pnl: row.pnl,
    operationsCount: row.operations_count,
    stopWinHit: !!row.stop_win_hit,
    stopLossHit: !!row.stop_loss_hit,
  };
}

export function saveDailyResult(db: Database.Database, r: DailyResult): void {
  db.prepare(
    `INSERT INTO daily_results (date, wins, losses, dojis, pnl, operations_count, stop_win_hit, stop_loss_hit)
     VALUES (@date, @wins, @losses, @dojis, @pnl, @operationsCount, @stopWinHit, @stopLossHit)
     ON CONFLICT(date) DO UPDATE SET wins=excluded.wins, losses=excluded.losses, dojis=excluded.dojis,
       pnl=excluded.pnl, operations_count=excluded.operations_count, stop_win_hit=excluded.stop_win_hit,
       stop_loss_hit=excluded.stop_loss_hit`
  ).run({
    date: r.date,
    wins: r.wins,
    losses: r.losses,
    dojis: r.dojis,
    pnl: r.pnl,
    operationsCount: r.operationsCount,
    stopWinHit: r.stopWinHit ? 1 : 0,
    stopLossHit: r.stopLossHit ? 1 : 0,
  });
}

export function insertBacktest(db: Database.Database, run: BacktestRun): void {
  db.prepare(`INSERT INTO backtests (id, active_ids_json, days, started_at, finished_at) VALUES (?, ?, ?, ?, ?)`).run(
    run.id,
    JSON.stringify(run.activeIds),
    run.days,
    run.startedAt,
    run.finishedAt ?? null
  );
}

export function finishBacktest(db: Database.Database, id: string, finishedAt: number): void {
  db.prepare(`UPDATE backtests SET finished_at = ? WHERE id = ?`).run(finishedAt, id);
}

export function insertBacktestOccurrence(db: Database.Database, backtestId: string, occ: PatternOccurrence): void {
  db.prepare(
    `INSERT INTO backtest_occurrences (id, backtest_id, active_id, occurred_at, candles_json, wick_percentage_11, candle13_json, result, is_first_of_day)
     VALUES (@id, @backtestId, @activeId, @occurredAt, @candlesJson, @wick, @candle13Json, @result, @isFirstOfDay)`
  ).run({
    id: occ.id,
    backtestId,
    activeId: occ.activeId,
    occurredAt: occ.occurredAt,
    candlesJson: serializeCandles(occ.candles),
    wick: occ.wickPercentage11,
    candle13Json: occ.candle13 ? JSON.stringify(occ.candle13) : null,
    result: occ.result ?? null,
    isFirstOfDay: occ.isFirstOfDay ? 1 : 0,
  });
}

export function listBacktestOccurrences(db: Database.Database, backtestId: string): PatternOccurrence[] {
  const rows = db
    .prepare(`SELECT * FROM backtest_occurrences WHERE backtest_id = ? ORDER BY occurred_at ASC`)
    .all(backtestId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    activeId: r.active_id as number,
    occurredAt: r.occurred_at as number,
    candles: deserializeCandles(r.candles_json as string),
    wickPercentage11: r.wick_percentage_11 as number,
    candle13: r.candle13_json ? (JSON.parse(r.candle13_json as string) as Candle) : undefined,
    result: (r.result as PatternOccurrence['result'] | null) ?? undefined,
    isFirstOfDay: !!r.is_first_of_day,
  }));
}
