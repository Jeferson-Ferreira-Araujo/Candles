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

async function setup(
  settingsOverrides: Partial<Settings> = {},
  serviceOptions: { pollIntervalMs?: number; maxPollAttempts?: number } = {}
) {
  const db = await getTestDb();
  await resetDb(db);
  const broker = new MockBrokerAdapter({ payout: 0.85, initialBalance: 1000 });
  await broker.authenticate();
  let settings = makeSettings(settingsOverrides);
  const service = new OrderService(db, broker, async () => settings, { pollIntervalMs: 5, maxPollAttempts: 30, ...serviceOptions });
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

  it('permite uma 2a ordem no MESMO ativo antes da primeira resolver (a Polarium aceita posicoes simultaneas)', async () => {
    const { db, broker, service } = await setup();
    const window1 = buildWindow(1_800_040_000);
    for (const c of window1) broker.pushLiveCandle(ACTIVE, c);
    await service.handleConfirmed(ACTIVE, window1, 0.5, DIRECTION);

    // Segundo "sinal" no MESMO ativo antes da primeira ordem resolver — nao deve ser bloqueado.
    const window2 = buildWindow(1_800_050_000);
    for (const c of window2) broker.pushLiveCandle(ACTIVE, c);
    await service.handleConfirmed(ACTIVE, window2, 0.5, DIRECTION);

    const signalId2 = `12CANDLES-${ACTIVE}-${window2[window2.length - 1]!.to}-PUT`;
    expect((await getSignal(db, signalId2))?.status).toBe('ORDER_CONFIRMED');

    const { rows } = await db.query('SELECT COUNT(*) as n FROM orders');
    expect(Number(rows[0].n)).toBe(2);
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

  it('Gale 1: LOSS na entrada original dispara reentrada automatica com o DOBRO do valor', async () => {
    // Janela de poll bem mais generosa que o padrao: a reentrada de Gale so e colocada DEPOIS
    // que a 1a ordem resolve (uma cadeia de chamadas assincronas — safety context, insert,
    // placeOrder), e so entao comeca a procurar a PROPRIA resolucao — com pollIntervalMs/
    // maxPollAttempts pequenos (padrao dos outros testes) isso pode facilmente estourar sob
    // carga da maquina, like um falso negativo por timing, nao por bug real.
    const { db, broker, service } = await setup(
      { galeEnabled: true, galeMaxLevels: 1, entryAmount: 5 },
      { pollIntervalMs: 10, maxPollAttempts: 300 }
    );
    const window = buildWindow(1_800_080_000);
    for (const c of window) broker.pushLiveCandle(ACTIVE, c);
    await service.handleConfirmed(ACTIVE, window, 0.5, DIRECTION);

    const lastCandle = window[window.length - 1]!;
    // Entrada original (PUT, amount 5) resolve como LOSS (fecha em alta).
    const lossCandle = green(lastCandle.to);
    broker.pushLiveCandle(ACTIVE, lossCandle);
    // Da tempo pro poll da 1a ordem detectar o LOSS e disparar (e CONFIRMAR, ida e volta real
    // com o broker) a reentrada de Gale antes de empurrar a vela que vai resolve-la.
    await new Promise((r) => setTimeout(r, 800));

    // A reentrada de Gale (amount 10, mesma direcao PUT) deve ter sido enviada automaticamente,
    // com openCandle = lossCandle — resolve no candle seguinte a ele. Fecha em baixa -> WIN.
    broker.pushLiveCandle(ACTIVE, red(lossCandle.to));
    await new Promise((r) => setTimeout(r, 2000));

    const { rows } = await db.query('SELECT * FROM orders ORDER BY requested_at ASC');
    expect(rows).toHaveLength(2);
    expect(Number(rows[0].amount)).toBe(5);
    expect(Number(rows[0].gale_level)).toBe(0);
    expect(rows[0].result).toBe('LOSS');
    expect(Number(rows[1].amount)).toBe(10);
    expect(Number(rows[1].gale_level)).toBe(1);
    expect(rows[1].result).toBe('WIN');
    expect(rows[1].root_signal_id).toBe(rows[0].signal_id);

    const daily = await getDailyResult(db, new Date().toISOString().slice(0, 10));
    expect(daily.operationsCount).toBe(2);
    expect(daily.wins).toBe(1);
    expect(daily.losses).toBe(1);
    expect(daily.pnl).toBeCloseTo(-5 + 10 * 0.85, 5);
  });

  it('sem Gale habilitado, uma LOSS nao dispara reentrada nenhuma', async () => {
    const { db, broker, service } = await setup({ galeEnabled: false });
    const window = buildWindow(1_800_090_000);
    for (const c of window) broker.pushLiveCandle(ACTIVE, c);
    await service.handleConfirmed(ACTIVE, window, 0.5, DIRECTION);

    broker.pushLiveCandle(ACTIVE, green(window[window.length - 1]!.to));
    await new Promise((r) => setTimeout(r, 1500));

    const { rows } = await db.query('SELECT * FROM orders');
    expect(rows).toHaveLength(1);
  });

  it('placeManualOrder envia uma ordem avulsa (sem padrao de 12 velas por tras) passando pelo SafetyGate', async () => {
    const { db, broker, service } = await setup();
    broker.pushLiveCandle(ACTIVE, green(1_800_100_000));

    const outcome = await service.placeManualOrder(ACTIVE, 'CALL');
    expect(outcome.allowed).toBe(true);
    expect(outcome.blockedBy).toEqual([]);

    const { rows } = await db.query('SELECT * FROM orders WHERE signal_id = $1', [outcome.signalId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].gale_level).toBe(0);
    expect(rows[0].root_signal_id).toBe(outcome.signalId);

    const status = (await getSignal(db, outcome.signalId))?.status;
    expect(status).toBe('ORDER_CONFIRMED');
  });

  it('placeManualOrder passa pelo SafetyGate normalmente, mas IGNORA o kill switch do robo', async () => {
    const { db, broker, service } = await setup({ robotActive: false });
    broker.pushLiveCandle(ACTIVE, green(1_800_110_000));
    const outcome = await service.placeManualOrder(ACTIVE, 'CALL');
    expect(outcome.allowed).toBe(true);
    expect(outcome.blockedBy).not.toContain('ROBOT_STOPPED');

    const { rows } = await db.query('SELECT * FROM orders WHERE signal_id = $1', [outcome.signalId]);
    expect(rows).toHaveLength(1);
  });
});
