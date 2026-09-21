import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { AppEvent, Candle, CandleColor, Direction } from '@polarium12c/shared';
import { getTestDb, resetDb } from './helpers/testDb.js';
import { MockBrokerAdapter } from '../src/broker/MockBrokerAdapter.js';
import { LiveMonitorService } from '../src/live/LiveMonitorService.js';
import { listEvents } from '../src/db/repositories.js';
import type { Db } from '../src/db/db.js';

const SIZE = 60;
const ACTIVE = 81;

/** Padrao de teste (prefixo de confirmacao) + direcao de entrada. */
const CONFIRM_PATTERN: CandleColor[] = ['G', 'R', 'G', 'R', 'R', 'G', 'R', 'R'];
const DIRECTION: Direction = 'PUT';

function green(from: number): Candle {
  return { activeId: ACTIVE, size: SIZE, from, to: from + SIZE, open: 1, close: 2, high: 2, low: 1, isClosed: true };
}
function red(from: number): Candle {
  return { activeId: ACTIVE, size: SIZE, from, to: from + SIZE, open: 2, close: 1, high: 2, low: 1, isClosed: true };
}

/** Vela com pavio inferior controlado (fracao do range, 0..1) — usada para a vela de sinal (regra final de pavio). */
function withWick(from: number, color: CandleColor, wickFraction: number): Candle {
  return color === 'G'
    ? { activeId: ACTIVE, size: SIZE, from, to: from + SIZE, open: wickFraction * 100, close: 100, high: 100, low: 0, isClosed: true }
    : { activeId: ACTIVE, size: SIZE, from, to: from + SIZE, open: 100, close: wickFraction * 100, high: 100, low: 0, isClosed: true };
}

/** A ULTIMA vela (a de sinal) sempre leva pavio de 50%, acima do minimo de 25% exigido. */
function buildTwelve(baseFrom: number): Candle[] {
  return CONFIRM_PATTERN.map((color: CandleColor, i: number) => {
    const from = baseFrom + i * SIZE;
    if (i === CONFIRM_PATTERN.length - 1) return withWick(from, color, 0.5);
    return color === 'G' ? green(from) : red(from);
  });
}

/** handleCandle agora persiste de forma assincrona (Postgres) antes de emitir os eventos —
 * da um respiro pro event loop processar essas promises pendentes antes de checar `received`. */
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

    const service = new LiveMonitorService(db, broker, [ACTIVE], CONFIRM_PATTERN, DIRECTION);
    await service.start();

    const received: AppEvent[] = [];
    service.on('event', (e: AppEvent) => received.push(e));

    const baseFrom = 1_800_000_000;
    for (const candle of buildTwelve(baseFrom)) {
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

  it('candle ainda aberto nunca gera CANDLE_CLOSED nem confirma nada', async () => {
    const broker = new MockBrokerAdapter();
    await broker.authenticate();
    const service = new LiveMonitorService(db, broker, [ACTIVE], CONFIRM_PATTERN, DIRECTION);
    await service.start();

    const received: AppEvent[] = [];
    service.on('event', (e: AppEvent) => received.push(e));

    const baseFrom = 1_800_000_000;
    // Alimenta todas menos a ultima vela do padrao, deixando a ultima posicao "em aberto".
    const allButLast = buildTwelve(baseFrom).slice(0, CONFIRM_PATTERN.length - 1);
    for (const c of allButLast) broker.pushLiveCandle(ACTIVE, c);
    await flush();

    received.length = 0; // limpa para isolar o efeito do candle aberto

    const lastClosed = allButLast[allButLast.length - 1]!;
    const forming: Candle = {
      activeId: ACTIVE,
      size: SIZE,
      from: lastClosed.to,
      to: lastClosed.to + SIZE,
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
    expect(progressEvent).toBeUndefined(); // candle aberto nunca alimenta o engine

    service.stop();
  });
});
