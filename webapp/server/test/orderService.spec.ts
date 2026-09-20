import { describe, expect, it } from 'vitest';
import type { AppEvent, Candle, Settings } from '@polarium12c/shared';
import { DEFAULT_SETTINGS, TWELVE_CANDLES_PATTERN } from '@polarium12c/shared';
import { openDb } from '../src/db/db.js';
import { MockBrokerAdapter } from '../src/broker/MockBrokerAdapter.js';
import { OrderService } from '../src/orders/OrderService.js';
import { getDailyResult, getSignal, listEvents } from '../src/db/repositories.js';

const SIZE = 60;
const ACTIVE = 81;

function green(from: number): Candle {
  return { activeId: ACTIVE, size: SIZE, from, to: from + SIZE, open: 1, close: 2, high: 2, low: 1, isClosed: true };
}
function red(from: number): Candle {
  return { activeId: ACTIVE, size: SIZE, from, to: from + SIZE, open: 2, close: 1, high: 2, low: 1, isClosed: true };
}
function redWithWick(from: number, wick: number): Candle {
  return { activeId: ACTIVE, size: SIZE, from, to: from + SIZE, open: 100, close: wick * 100, high: 100, low: 0, isClosed: true };
}

function buildWindow(baseFrom: number): Candle[] {
  return TWELVE_CANDLES_PATTERN.map((color, i) => {
    const from = baseFrom + i * SIZE;
    return i === 10 ? redWithWick(from, 0.5) : color === 'G' ? green(from) : red(from);
  });
}

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return { ...DEFAULT_SETTINGS, mode: 'DEMO', robotActive: true, entryAmount: 5, ...overrides };
}

async function setup(settingsOverrides: Partial<Settings> = {}) {
  const db = openDb(':memory:');
  const broker = new MockBrokerAdapter({ payout: 0.85, initialBalance: 1000 });
  await broker.authenticate();
  let settings = makeSettings(settingsOverrides);
  const service = new OrderService(db, broker, () => settings, { pollIntervalMs: 5, maxPollAttempts: 30 });
  return {
    db,
    broker,
    service,
    setSettings: (s: Partial<Settings>) => {
      settings = { ...settings, ...s };
    },
  };
}

describe('OrderService', () => {
  it('fluxo feliz: confirma sinal em DEMO, envia ordem, resolve WIN e atualiza o resultado do dia', async () => {
    const { db, broker, service } = await setup();
    const window = buildWindow(1_800_000_000);
    for (const c of window) broker.pushLiveCandle(ACTIVE, c);

    await service.handleConfirmed(ACTIVE, window, 0.5);

    const signalId = `12CANDLES-${ACTIVE}-${window[11]!.to}-CALL`;
    expect(getSignal(db, signalId)?.status).toBe('ORDER_CONFIRMED');

    // Fecha a 13a vela (WIN: close > open) para o MockBroker resolver a ordem.
    broker.pushLiveCandle(ACTIVE, green(window[11]!.to));

    // O polling roda em background — espera ele convergir.
    await new Promise((r) => setTimeout(r, 100));

    expect(getSignal(db, signalId)?.status).toBe('WIN');
    const daily = getDailyResult(db, new Date().toISOString().slice(0, 10));
    expect(daily.wins).toBe(1);
    expect(daily.operationsCount).toBe(1);

    const events = listEvents(db, 50).map((e) => e.type);
    expect(events).toEqual(expect.arrayContaining(['ORDER_REQUESTED', 'ORDER_CONFIRMED', 'WIN']));
  });

  it('OBSERVATION nunca envia ordem, so registra o bloqueio', async () => {
    const { db, broker, service } = await setup({ mode: 'OBSERVATION' });
    const window = buildWindow(1_800_010_000);
    for (const c of window) broker.pushLiveCandle(ACTIVE, c);

    await service.handleConfirmed(ACTIVE, window, 0.5);

    const signalId = `12CANDLES-${ACTIVE}-${window[11]!.to}-CALL`;
    expect(getSignal(db, signalId)?.status).toBe('BLOCKED');
    const events = listEvents(db, 50);
    expect(events.some((e) => e.type === 'BLOCKED_BY_SAFETY_CHECK')).toBe(true);
    expect(events.some((e) => e.type === 'ORDER_REQUESTED')).toBe(false);
  });

  it('kill switch (robotActive=false) bloqueia mesmo em DEMO', async () => {
    const { db, broker, service } = await setup({ robotActive: false });
    const window = buildWindow(1_800_020_000);
    for (const c of window) broker.pushLiveCandle(ACTIVE, c);

    await service.handleConfirmed(ACTIVE, window, 0.5);

    const signalId = `12CANDLES-${ACTIVE}-${window[11]!.to}-CALL`;
    expect(getSignal(db, signalId)?.status).toBe('BLOCKED');
  });

  it('sinal duplicado (mesmo signalId) nunca gera uma segunda ordem', async () => {
    const { db, broker, service } = await setup();
    const window = buildWindow(1_800_030_000);
    for (const c of window) broker.pushLiveCandle(ACTIVE, c);

    await service.handleConfirmed(ACTIVE, window, 0.5);
    await service.handleConfirmed(ACTIVE, window, 0.5); // repete o mesmo sinal

    const orderCount = db.prepare('SELECT COUNT(*) as n FROM orders').get() as { n: number };
    expect(orderCount.n).toBe(1);
  });

  it('ordem pendente no mesmo ativo bloqueia um novo sinal ate a primeira resolver', async () => {
    const { db, broker, service } = await setup();
    const window1 = buildWindow(1_800_040_000);
    for (const c of window1) broker.pushLiveCandle(ACTIVE, c);
    await service.handleConfirmed(ACTIVE, window1, 0.5);

    // Segundo "sinal" no MESMO ativo antes da primeira ordem resolver.
    const window2 = buildWindow(1_800_050_000);
    for (const c of window2) broker.pushLiveCandle(ACTIVE, c);
    await service.handleConfirmed(ACTIVE, window2, 0.5);

    const signalId2 = `12CANDLES-${ACTIVE}-${window2[11]!.to}-CALL`;
    expect(getSignal(db, signalId2)?.status).toBe('BLOCKED');

    const orderCount = db.prepare('SELECT COUNT(*) as n FROM orders').get() as { n: number };
    expect(orderCount.n).toBe(1);
  });

  it('Stop Loss diario bloqueia novos sinais depois de atingido', async () => {
    const { db, broker, service, setSettings } = await setup({ stopLossDaily: 3 });
    const window = buildWindow(1_800_060_000);
    for (const c of window) broker.pushLiveCandle(ACTIVE, c);
    await service.handleConfirmed(ACTIVE, window, 0.5);

    // Resolve como LOSS (13a fecha abaixo da abertura).
    broker.pushLiveCandle(ACTIVE, red(window[11]!.to));
    await new Promise((r) => setTimeout(r, 100));

    const daily = getDailyResult(db, new Date().toISOString().slice(0, 10));
    expect(daily.losses).toBe(1);
    expect(daily.stopLossHit).toBe(true);

    const events = listEvents(db, 50).map((e: AppEvent) => e.type);
    expect(events).toContain('STOP_LOSS');

    // Novo sinal em outro ativo, mesmo dia — deve ser bloqueado pelo Stop Loss.
    setSettings({}); // no-op, so garante que pegamos as settings atuais (mesmo objeto)
    const window2 = buildWindow(1_800_070_000);
    const OTHER_ACTIVE = 76;
    const window2Other = window2.map((c) => ({ ...c, activeId: OTHER_ACTIVE }));
    for (const c of window2Other) broker.pushLiveCandle(OTHER_ACTIVE, c);
    await service.handleConfirmed(OTHER_ACTIVE, window2Other, 0.5);

    const signalId2 = `12CANDLES-${OTHER_ACTIVE}-${window2Other[11]!.to}-CALL`;
    expect(getSignal(db, signalId2)?.status).toBe('BLOCKED');
  });
});
