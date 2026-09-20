import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppEvent, Candle, CandleColor } from '@polarium12c/shared';
import { TWELVE_CANDLES_PATTERN } from '@polarium12c/shared';
import { getTestDb, resetDb } from './helpers/testDb.js';
import { MockBrokerAdapter } from '../src/broker/MockBrokerAdapter.js';
import { LiveMonitorService } from '../src/live/LiveMonitorService.js';
import { listEvents } from '../src/db/repositories.js';
import type { Db } from '../src/db/db.js';

const SIZE = 60;
const ACTIVE = 81;

function green(from: number): Candle {
  return { activeId: ACTIVE, size: SIZE, from, to: from + SIZE, open: 1, close: 2, high: 2, low: 1, isClosed: true };
}
function red(from: number): Candle {
  return { activeId: ACTIVE, size: SIZE, from, to: from + SIZE, open: 2, close: 1, high: 2, low: 1, isClosed: true };
}
function redWithWick(from: number, wickFraction: number): Candle {
  return { activeId: ACTIVE, size: SIZE, from, to: from + SIZE, open: 100, close: wickFraction * 100, high: 100, low: 0, isClosed: true };
}

function buildTwelve(baseFrom: number, wick: number): Candle[] {
  return TWELVE_CANDLES_PATTERN.map((color: CandleColor, i: number) => {
    const from = baseFrom + i * SIZE;
    return i === 10 ? redWithWick(from, wick) : color === 'G' ? green(from) : red(from);
  });
}

/** handleCandle agora persiste de forma assincrona (Postgres) antes de emitir os eventos —
 * da um respiro pro event loop processar essas promises pendentes antes de checar `received`.
 * A regra hoje tem TWELVE_CANDLES_PATTERN.length velas (13) — uma a mais que antes — entao
 * o teste que alimenta o padrao inteiro precisa de mais margem que o antigo 1000ms fixo. */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 3500));
}

describe('LiveMonitorService (replay via MockBrokerAdapter)', () => {
  let db: Db;

  beforeEach(async () => {
    db = await getTestDb();
    await resetDb(db);
  });

  afterAll(async () => {
    await db.end();
  });

  it('recebe candles "ao vivo" via subscribeCandles, alimenta o engine, persiste candles/eventos e emite PATTERN_CONFIRMED', async () => {
    const broker = new MockBrokerAdapter();
    await broker.authenticate();

    const service = new LiveMonitorService(db, broker, [ACTIVE]);
    await service.start();

    const received: AppEvent[] = [];
    service.on('event', (e: AppEvent) => received.push(e));

    const baseFrom = 1_800_000_000;
    for (const candle of buildTwelve(baseFrom, 0.5)) {
      broker.pushLiveCandle(ACTIVE, candle);
    }
    await flush();

    expect(received.some((e) => e.type === 'CANDLE_CLOSED')).toBe(true);
    expect(received.some((e) => e.type === 'PATTERN_PROGRESS')).toBe(true);
    const confirmed = received.find((e) => e.type === 'PATTERN_CONFIRMED');
    expect(confirmed).toBeDefined();
    expect(confirmed?.activeId).toBe(ACTIVE);

    // Persistencia real: os eventos devem estar no banco, nao so em memoria no EventEmitter.
    const persistedEvents = await listEvents(db, 100);
    expect(persistedEvents.some((e) => e.type === 'PATTERN_CONFIRMED')).toBe(true);

    service.stop();
  });

  it('candle ainda aberto nunca gera CANDLE_CLOSED nem confirma nada, so preview quando aplicavel', async () => {
    const broker = new MockBrokerAdapter();
    await broker.authenticate();
    const service = new LiveMonitorService(db, broker, [ACTIVE]);
    await service.start();

    const received: AppEvent[] = [];
    service.on('event', (e: AppEvent) => received.push(e));

    const baseFrom = 1_800_000_000;
    const tenClosed = buildTwelve(baseFrom, 0.5).slice(0, 10);
    for (const c of tenClosed) broker.pushLiveCandle(ACTIVE, c);
    await flush();

    received.length = 0; // limpa para isolar o efeito do candle aberto

    const forming: Candle = {
      activeId: ACTIVE,
      size: SIZE,
      from: tenClosed[9]!.to,
      to: tenClosed[9]!.to + SIZE,
      open: 100,
      close: 40,
      high: 100,
      low: 0,
      isClosed: false,
    };
    broker.pushLiveCandle(ACTIVE, forming);
    await flush();

    expect(received.some((e) => e.type === 'CANDLE_CLOSED')).toBe(false);
    expect(received.some((e) => e.type === 'PATTERN_CONFIRMED')).toBe(false);
    const progressEvent = received.find((e) => e.type === 'PATTERN_PROGRESS');
    expect(progressEvent).toBeDefined();
    expect((progressEvent!.payload as any).progress.wick11.candleClosed).toBe(false);

    service.stop();
  });
});
