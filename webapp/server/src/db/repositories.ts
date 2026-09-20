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
import type { Db } from './db.js';

/**
 * Repositorios finos sobre `pg`. Sem ORM: as queries sao explicitas e pequenas o
 * suficiente para revisar a olho — importante para um app que decide sozinho quando
 * enviar ordens. Colunas JSONB sao lidas/escritas como objetos JS diretos — o driver `pg`
 * serializa/desserializa JSON automaticamente, sem JSON.stringify/parse manual.
 */

export type CandleSource = 'live' | 'backtest' | 'mock';

export async function saveCandle(db: Db, c: Candle, source: CandleSource): Promise<void> {
  await db.query(
    `INSERT INTO candles (active_id, size, from_ts, to_ts, open, high, low, close, is_closed, source, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (active_id, size, from_ts, source) DO UPDATE SET
       to_ts = excluded.to_ts, open = excluded.open, high = excluded.high, low = excluded.low,
       close = excluded.close, is_closed = excluded.is_closed`,
    [c.activeId, c.size, c.from, c.to, c.open, c.high, c.low, c.close, c.isClosed, source, Date.now()]
  );
}

export async function getCandles(db: Db, activeId: number, size: number, source: CandleSource, limit = 500): Promise<Candle[]> {
  const { rows } = await db.query(
    `SELECT active_id as "activeId", size, from_ts as "from", to_ts as "to", open, high, low, close, is_closed as "isClosed"
     FROM candles WHERE active_id = $1 AND size = $2 AND source = $3 ORDER BY from_ts DESC LIMIT $4`,
    [activeId, size, source, limit]
  );
  // active_id/from/to sao BIGINT — o driver pg retorna como string para nao perder
  // precisao; convertemos explicitamente de volta para number aqui.
  return (rows as Array<Record<string, unknown>>)
    .map((r) => ({
      activeId: Number(r.activeId),
      size: r.size as number,
      from: Number(r.from),
      to: Number(r.to),
      open: r.open as number,
      high: r.high as number,
      low: r.low as number,
      close: r.close as number,
      isClosed: r.isClosed as boolean,
    }))
    .reverse();
}

export async function saveSignal(db: Db, s: Signal): Promise<void> {
  await db.query(
    `INSERT INTO signals (id, active_id, direction, created_at, pattern_json, wick_percentage_11, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [s.id, s.activeId, s.direction, s.createdAt, JSON.stringify(s.candles), s.wickPercentage11, s.status]
  );
}

export async function getSignal(db: Db, id: string): Promise<Signal | undefined> {
  const { rows } = await db.query(`SELECT * FROM signals WHERE id = $1`, [id]);
  const row = rows[0] as
    | {
        id: string;
        active_id: number;
        direction: string;
        created_at: string;
        pattern_json: Candle[];
        wick_percentage_11: number;
        status: string;
      }
    | undefined;
  if (!row) return undefined;
  return {
    id: row.id,
    activeId: Number(row.active_id),
    direction: row.direction as Signal['direction'],
    createdAt: Number(row.created_at),
    candles: row.pattern_json,
    wickPercentage11: row.wick_percentage_11,
    status: row.status as Signal['status'],
  };
}

export async function updateSignalStatus(db: Db, id: string, status: Signal['status']): Promise<void> {
  await db.query(`UPDATE signals SET status = $1 WHERE id = $2`, [status, id]);
}

/**
 * Insere a ordem SOMENTE se ainda nao existir uma ordem para este signal_id (protecao
 * persistida contra ordem duplicada, exigida pela regra de seguranca). Retorna a ordem
 * que ficou registrada (a que acabou de ser inserida, ou a existente se ja havia uma).
 */
export async function insertOrderIfAbsent(db: Db, o: OrderRecord): Promise<{ inserted: boolean; order: OrderRecord }> {
  const existing = await getOrderBySignalId(db, o.signalId);
  if (existing) return { inserted: false, order: existing };

  try {
    await db.query(
      `INSERT INTO orders (id, signal_id, broker_order_id, active_id, direction, amount, status, requested_at, confirmed_at, resolved_at, result, payout_percentage, pnl, mode)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
      [
        o.id,
        o.signalId,
        o.brokerOrderId ?? null,
        o.activeId,
        o.direction,
        o.amount,
        o.status,
        o.requestedAt,
        o.confirmedAt ?? null,
        o.resolvedAt ?? null,
        o.result ?? null,
        o.payoutPercentage ?? null,
        o.pnl ?? null,
        o.mode,
      ]
    );
    return { inserted: true, order: o };
  } catch (err) {
    // Corrida: outra chamada concorrente inseriu entre o SELECT e o INSERT acima —
    // o UNIQUE(signal_id) barrou esta segunda tentativa. Trata como "ja existia".
    const already = await getOrderBySignalId(db, o.signalId);
    if (already) return { inserted: false, order: already };
    throw err;
  }
}

function rowToOrder(row: Record<string, unknown>): OrderRecord {
  return {
    id: row.id as string,
    signalId: row.signal_id as string,
    brokerOrderId: (row.broker_order_id as string | null) ?? undefined,
    activeId: Number(row.active_id),
    direction: row.direction as OrderRecord['direction'],
    amount: row.amount as number,
    status: row.status as OrderRecord['status'],
    requestedAt: Number(row.requested_at),
    confirmedAt: row.confirmed_at !== null ? Number(row.confirmed_at) : undefined,
    resolvedAt: row.resolved_at !== null ? Number(row.resolved_at) : undefined,
    result: (row.result as OrderRecord['result'] | null) ?? undefined,
    payoutPercentage: (row.payout_percentage as number | null) ?? undefined,
    pnl: (row.pnl as number | null) ?? undefined,
    mode: row.mode as OrderRecord['mode'],
  };
}

export async function getOrderBySignalId(db: Db, signalId: string): Promise<OrderRecord | undefined> {
  const { rows } = await db.query(`SELECT * FROM orders WHERE signal_id = $1`, [signalId]);
  return rows[0] ? rowToOrder(rows[0]) : undefined;
}

export async function updateOrder(db: Db, id: string, patch: Partial<OrderRecord>): Promise<void> {
  const { rows } = await db.query(`SELECT * FROM orders WHERE id = $1`, [id]);
  if (!rows[0]) throw new Error(`Order ${id} nao encontrada`);
  const merged = { ...rowToOrder(rows[0]), ...patch };
  await db.query(
    `UPDATE orders SET broker_order_id=$1, status=$2, confirmed_at=$3,
     resolved_at=$4, result=$5, payout_percentage=$6, pnl=$7 WHERE id=$8`,
    [
      merged.brokerOrderId ?? null,
      merged.status,
      merged.confirmedAt ?? null,
      merged.resolvedAt ?? null,
      merged.result ?? null,
      merged.payoutPercentage ?? null,
      merged.pnl ?? null,
      id,
    ]
  );
}

export async function listOrders(db: Db, limit = 200): Promise<OrderRecord[]> {
  const { rows } = await db.query(`SELECT * FROM orders ORDER BY requested_at DESC LIMIT $1`, [limit]);
  return rows.map(rowToOrder);
}

/** True se existe alguma ordem para este ativo ainda sem resultado (aberta ou de status desconhecido). */
export async function hasPendingOrderForActive(db: Db, activeId: number): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT COUNT(*) as n FROM orders WHERE active_id = $1 AND status IN ('REQUESTED', 'CONFIRMED', 'UNKNOWN')`,
    [activeId]
  );
  return Number(rows[0].n) > 0;
}

export async function listUnknownOrders(db: Db): Promise<OrderRecord[]> {
  const { rows } = await db.query(`SELECT * FROM orders WHERE status = 'UNKNOWN'`);
  return rows.map(rowToOrder);
}

export async function insertEvent(db: Db, e: AppEvent): Promise<void> {
  await db.query(`INSERT INTO events (id, type, active_id, payload_json, created_at) VALUES ($1, $2, $3, $4, $5)`, [
    e.id,
    e.type,
    e.activeId ?? null,
    JSON.stringify(e.payload),
    e.createdAt,
  ]);
}

export async function listEvents(db: Db, limit = 200): Promise<AppEvent[]> {
  const { rows } = await db.query(`SELECT * FROM events ORDER BY created_at DESC LIMIT $1`, [limit]);
  return (rows as Array<{ id: string; type: string; active_id: string | null; payload_json: unknown; created_at: string }>).map(
    (r) => ({
      id: r.id,
      type: r.type as AppEvent['type'],
      activeId: r.active_id !== null ? Number(r.active_id) : undefined,
      payload: r.payload_json as Record<string, unknown>,
      createdAt: Number(r.created_at),
    })
  );
}

export async function loadSettings(db: Db): Promise<Settings> {
  const { rows } = await db.query(`SELECT value_json FROM settings WHERE key = 'settings'`);
  if (!rows[0]) return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...(rows[0].value_json as Partial<Settings>) };
}

export async function saveSettings(db: Db, settings: Settings): Promise<void> {
  await db.query(
    `INSERT INTO settings (key, value_json) VALUES ('settings', $1)
     ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json`,
    [JSON.stringify(settings)]
  );
}

export async function getDailyResult(db: Db, date: string): Promise<DailyResult> {
  const { rows } = await db.query(`SELECT * FROM daily_results WHERE date = $1`, [date]);
  const row = rows[0] as
    | {
        date: string;
        wins: number;
        losses: number;
        dojis: number;
        pnl: number;
        operations_count: number;
        stop_win_hit: boolean;
        stop_loss_hit: boolean;
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
    stopWinHit: row.stop_win_hit,
    stopLossHit: row.stop_loss_hit,
  };
}

export async function saveDailyResult(db: Db, r: DailyResult): Promise<void> {
  await db.query(
    `INSERT INTO daily_results (date, wins, losses, dojis, pnl, operations_count, stop_win_hit, stop_loss_hit)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (date) DO UPDATE SET wins=excluded.wins, losses=excluded.losses, dojis=excluded.dojis,
       pnl=excluded.pnl, operations_count=excluded.operations_count, stop_win_hit=excluded.stop_win_hit,
       stop_loss_hit=excluded.stop_loss_hit`,
    [r.date, r.wins, r.losses, r.dojis, r.pnl, r.operationsCount, r.stopWinHit, r.stopLossHit]
  );
}

export async function insertBacktest(db: Db, run: BacktestRun): Promise<void> {
  await db.query(`INSERT INTO backtests (id, active_ids_json, days, started_at, finished_at) VALUES ($1, $2, $3, $4, $5)`, [
    run.id,
    JSON.stringify(run.activeIds),
    run.days,
    run.startedAt,
    run.finishedAt ?? null,
  ]);
}

export async function finishBacktest(db: Db, id: string, finishedAt: number): Promise<void> {
  await db.query(`UPDATE backtests SET finished_at = $1 WHERE id = $2`, [finishedAt, id]);
}

export async function insertBacktestOccurrence(db: Db, backtestId: string, occ: PatternOccurrence): Promise<void> {
  await db.query(
    `INSERT INTO backtest_occurrences (id, backtest_id, active_id, occurred_at, candles_json, wick_percentage_11, candle13_json, result, is_first_of_day)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      occ.id,
      backtestId,
      occ.activeId,
      occ.occurredAt,
      JSON.stringify(occ.candles),
      occ.wickPercentage11,
      occ.candle13 ? JSON.stringify(occ.candle13) : null,
      occ.result ?? null,
      occ.isFirstOfDay,
    ]
  );
}

export async function listBacktestOccurrences(db: Db, backtestId: string): Promise<PatternOccurrence[]> {
  const { rows } = await db.query(`SELECT * FROM backtest_occurrences WHERE backtest_id = $1 ORDER BY occurred_at ASC`, [
    backtestId,
  ]);
  return (rows as Array<Record<string, unknown>>).map((r) => ({
    id: r.id as string,
    activeId: Number(r.active_id),
    occurredAt: Number(r.occurred_at),
    candles: r.candles_json as Candle[],
    wickPercentage11: r.wick_percentage_11 as number,
    candle13: (r.candle13_json as Candle | null) ?? undefined,
    result: (r.result as PatternOccurrence['result'] | null) ?? undefined,
    isFirstOfDay: r.is_first_of_day as boolean,
  }));
}
