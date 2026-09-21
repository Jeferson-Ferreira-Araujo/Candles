import { afterAll, describe, expect, it } from 'vitest';
import type { AppEvent, Candle, CandleColor, Direction, Settings } from '@polarium12c/shared';
import { DEFAULT_SETTINGS } from '@polarium12c/shared';
import { getTestDb, resetDb } from './helpers/testDb.js';
import { MockBrokerAdapter } from '../src/broker/MockBrokerAdapter.js';
import { OrderService } from '../src/orders/OrderService.js';
import { getDailyResult, getSignal, listEvents } from '../src/db/repositories.js';

const SIZE = 60;
const ACTIVE = 81;
const DIRECTION: Direction = 'PUT';

/** Padrao de teste (prefixo de confirmacao). */
const CONFIRM_PATTERN: CandleColor[] = ['G', 'R', 'G', 'R', 'R', 'G', 'R', 'R'];

function green(from: number): Candle {
  return { activeId: ACTIVE, size: SIZE, from, to: from + SIZE, open: 1, close: 2, high: 2, low: 1, isClosed: true };
}
function red(from: number): Candle {
  return { activeId: ACTIVE, size: SIZE, from, to: from + SIZE, open: 2, close: 1, high: 2, low: 1, isClosed: true };
}

function buildWindow(baseFrom: number): Candle[] {
  return CONFIRM_PATTERN.map((color: CandleColor, i: number) => {
    const from = baseFrom + i * SIZE;
    return color === 'G' ? green(from) : red(from);
  });
}

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, mode: 'DEMO', robotActive: true, entryAmount: 5, ...overrides };
}

async function setup(settingsOverrides: Partial<Settings> = {}) {
  const db = await getTestDb();
  await resetDb(db);
  const broker = new MockBrokerAdapter({ payout: 0.85, initialBalance: 1000 });
  await broker.authenticate();
  let settings = makeSettings(settingsOverrides);
  const service = new OrderService(db, broker, async () => settings, { pollIntervalMs: 5, maxPollAttempts: 30 });
  return {
    db,
    broker,
    service,
    setSettings: (s: Partial<Settings>) => {
      settings = { ...settings, ...s };
    },
  };
}

afterAll(async () => {
  const db = await getTestDb();
  await db.end();
});

describe('OrderService', () => {
  it('fluxo feliz: confirma sinal em DEMO, envia ordem, resolve WIN e atualiza o resultado do dia', async () => {
    const { db, broker, service } = await setup();
    const window = buildWindow(1_800_000_000);
    for (const c of window) broker.pushLiveCandle(ACTIVE, c);

    await service.handleConfirmed(ACTIVE, window, 0.5, DIRECTION);

    const lastCandle = window[window.length - 1]!;
    const signalId = `12CANDLES-${ACTIVE}-${lastCandle.to}-PUT`;
    expect((await getSignal(db, signalId))?.status).toBe('ORDER_CONFIRMED');

    // Fecha a vela de entrada (WIN para PUT: close < open) para o MockBroker resolver a ordem.
    broker.pushLiveCandle(ACTIVE, red(lastCandle.to));

    // O polling roda em background — espera ele convergir.
    await new Promise((r) => setTimeout(r, 1500));

    expect((await getSignal(db, signalId))?.status).toBe('WIN');
    const daily = await getDailyResult(db, new Date().toISOString().slice(0, 10));
    expect(daily.wins).toBe(1);
    expect(daily.operationsCount).toBe(1);

    const events = (await listEvents(db, 50)).map((e) => e.type);
    expect(events).toEqual(expect.arrayContaining(['ORDER_REQUESTED', 'ORDER_CONFIRMED', 'WIN']));
  });

  it('OBSERVATION nunca envia ordem, so registra o bloqueio', async () => {
    const { db, broker, service } = await setup({ mode: 'OBSERVATION' });
    const window = buildWindow(1_800_010_000);
    for (const c of window) broker.pushLiveCandle(ACTIVE, c);

    await service.handleConfirmed(ACTIVE, window, 0.5, DIRECTION);

    const signalId = `12CANDLES-${ACTIVE}-${window[window.length - 1]!.to}-PUT`;
    expect((await getSignal(db, signalId))?.status).toBe('BLOCKED');
    const events = await listEvents(db, 50);
    expect(events.some((e) => e.type === 'BLOCKED_BY_SAFETY_CHECK')).toBe(true);
    expect(events.some((e) => e.type === 'ORDER_REQUESTED')).toBe(false);
  });

  it('kill switch (robotActive=false) bloqueia mesmo em DEMO', async () => {
    const { db, broker, service } = await setup({ robotActive: false });
    const window = buildWindow(1_800_020_000);
    for (const c of window) broker.pushLiveCandle(ACTIVE, c);

    await service.handleConfirmed(ACTIVE, window, 0.5, DIRECTION);

    const signalId = `12CANDLES-${ACTIVE}-${window[window.length - 1]!.to}-PUT`;
    expect((await getSignal(db, signalId))?.status).toBe('BLOCKED');
  });

  it('sinal duplicado (mesmo signalId) nunca gera uma segunda ordem', async () => {
    const { db, broker, service } = await setup();
    const window = buildWindow(1_800_030_000);
    for (const c of window) broker.pushLiveCandle(ACTIVE, c);

    await service.handleConfirmed(ACTIVE, window, 0.5, DIRECTION);
    await service.handleConfirmed(ACTIVE, window, 0.5, DIRECTION); // repete o mesmo sinal

    const { rows } = await db.query('SELECT COUNT(*) as n FROM orders');
    expect(Number(rows[0].n)).toBe(1);
  });

  it('ordem pendente no mesmo ativo bloqueia um novo sinal ate a primeira resolver', async () => {
    const { db, broker, service } = await setup();
    const window1 = buildWindow(1_800_040_000);
    for (const c of window1) broker.pushLiveCandle(ACTIVE, c);
    await service.handleConfirmed(ACTIVE, window1, 0.5, DIRECTION);

    // Segundo "sinal" no MESMO ativo antes da primeira ordem resolver.
    const window2 = buildWindow(1_800_050_000);
    for (const c of window2) broker.pushLiveCandle(ACTIVE, c);
    await service.handleConfirmed(ACTIVE, window2, 0.5, DIRECTION);

    const signalId2 = `12CANDLES-${ACTIVE}-${window2[window2.length - 1]!.to}-PUT`;
    expect((await getSignal(db, signalId2))?.status).toBe('BLOCKED');

    const { rows } = await db.query('SELECT COUNT(*) as n FROM orders');
    expect(Number(rows[0].n)).toBe(1);
  });

  it('Stop Loss diario bloqueia novos sinais depois de atingido', async () => {
    const { db, broker, service, setSettings } = await setup({ stopLossDaily: 3 });
    const window = buildWindow(1_800_060_000);
    for (const c of window) broker.pushLiveCandle(ACTIVE, c);
    await service.handleConfirmed(ACTIVE, window, 0.5, DIRECTION);

    // Resolve como LOSS para PUT (vela de entrada fecha ACIMA da abertura).
    broker.pushLiveCandle(ACTIVE, green(window[window.length - 1]!.to));
    await new Promise((r) => setTimeout(r, 1500));

    const daily = await getDailyResult(db, new Date().toISOString().slice(0, 10));
    expect(daily.losses).toBe(1);
    expect(daily.stopLossHit).toBe(true);

    const events = (await listEvents(db, 50)).map((e: AppEvent) => e.type);
    expect(events).toContain('STOP_LOSS');

    // Novo sinal em outro ativo, mesmo dia — deve ser bloqueado pelo Stop Loss.
    setSettings({}); // no-op, so garante que pegamos as settings atuais (mesmo objeto)
    const window2 = buildWindow(1_800_070_000);
    const OTHER_ACTIVE = 76;
    const window2Other = window2.map((c) => ({ ...c, activeId: OTHER_ACTIVE }));
    for (const c of window2Other) broker.pushLiveCandle(OTHER_ACTIVE, c);
    await service.handleConfirmed(OTHER_ACTIVE, window2Other, 0.5, DIRECTION);

    const signalId2 = `12CANDLES-${OTHER_ACTIVE}-${window2Other[window2Other.length - 1]!.to}-PUT`;
    expect((await getSignal(db, signalId2))?.status).toBe('BLOCKED');
  });
});
