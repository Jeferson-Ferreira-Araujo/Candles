import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Candle } from '@polarium12c/shared';
import { TWELVE_CANDLES_PATTERN } from '@polarium12c/shared';
import { getTestDb, resetDb } from './helpers/testDb.js';
import { MockBrokerAdapter } from '../src/broker/MockBrokerAdapter.js';
import { runBacktest } from '../src/backtest/backtestRunner.js';
import { listBacktestOccurrences } from '../src/db/repositories.js';
import type { Db } from '../src/db/db.js';

const SIZE = 60;

function green(activeId: number, from: number): Candle {
  return { activeId, size: SIZE, from, to: from + SIZE, open: 1, close: 2, high: 2, low: 1, isClosed: true };
}
function red(activeId: number, from: number): Candle {
  return { activeId, size: SIZE, from, to: from + SIZE, open: 2, close: 1, high: 2, low: 1, isClosed: true };
}
function redWithWick(activeId: number, from: number, wickFraction: number): Candle {
  return { activeId, size: SIZE, from, to: from + SIZE, open: 100, close: wickFraction * 100, high: 100, low: 0, isClosed: true };
}

/** Constroi N ocorrencias consecutivas e nao sobrepostas do padrao completo (13 velas cada: 12 + resultado). */
function buildOccurrences(activeId: number, baseFrom: number, count: number, resultDirectionUp: boolean): Candle[] {
  const candles: Candle[] = [];
  let from = baseFrom;
  for (let n = 0; n < count; n++) {
    for (let i = 0; i < TWELVE_CANDLES_PATTERN.length; i++) {
      const color = TWELVE_CANDLES_PATTERN[i];
      candles.push(i === 10 ? redWithWick(activeId, from, 0.5) : color === 'G' ? green(activeId, from) : red(activeId, from));
      from += SIZE;
    }
    // 13a vela (resultado do CALL) + 1 candle "separador" neutro para nao encostar na proxima ocorrencia
    candles.push(resultDirectionUp ? green(activeId, from) : red(activeId, from));
    from += SIZE;
  }
  return candles;
}

/**
 * Ancora um timestamp dentro do dia UTC atual, longe o suficiente da meia-noite para que
 * nenhuma sequencia curta de candles construida a partir dele possa atravessar a virada de
 * dia. Usar `Date.now() - Nh` diretamente e fragil: perto da meia-noite UTC, isso pode cair
 * no dia ANTERIOR e quebrar testes que dependem de duas ocorrencias caindo no mesmo dia
 * (exatamente o que aconteceu ao rodar este teste as ~05h UTC).
 */
function safeDayStart(): number {
  const now = Math.floor(Date.now() / 1000);
  const todayMidnightUtc = Math.floor(now / 86_400) * 86_400;
  return todayMidnightUtc + 2 * 60 * 60; // 02:00 UTC do dia atual
}

describe('runBacktest', () => {
  let db: Db;

  beforeEach(async () => {
    db = await getTestDb();
    await resetDb(db);
  });

  afterAll(async () => {
    await db.end();
  });

  it('detecta multiplas ocorrencias, calcula WIN/LOSS pela 13a vela, e separa "todas" de "primeira do dia"', async () => {
    const broker = new MockBrokerAdapter();
    await broker.authenticate();

    // Precisa cair dentro da janela real de `days` (30) a partir de agora, ja que
    // runBacktest usa Date.now() internamente — nao um dia fixo no passado.
    const dayStart = safeDayStart();
    const activeId = 81;

    // 2 ocorrencias no mesmo "dia logico" do teste (nao precisa ser exatamente 1 dia UTC
    // real aqui, so precisamos de >=2 ocorrencias no total para testar a separacao).
    const candles = buildOccurrences(activeId, dayStart, 2, true);
    broker.seedCandles(activeId, candles);

    const { occurrences, summary } = await runBacktest(db, broker, [activeId], 30);

    expect(occurrences).toHaveLength(2);
    expect(occurrences.every((o) => o.result === 'WIN')).toBe(true);
    expect(occurrences.filter((o) => o.isFirstOfDay)).toHaveLength(1);
    expect(occurrences[0]!.isFirstOfDay).toBe(true);
    expect(occurrences[1]!.isFirstOfDay).toBe(false);

    expect(summary.allOccurrences).toEqual({ wins: 2, losses: 0, dojis: 0 });
    expect(summary.firstOfDayOnly).toEqual({ wins: 1, losses: 0, dojis: 0 });

    // As ocorrencias devem ter sido persistidas de verdade no banco (nao so em memoria).
    const persisted = await listBacktestOccurrences(db, summary.runId);
    expect(persisted).toHaveLength(2);
    expect(persisted.map((o) => o.result)).toEqual(['WIN', 'WIN']);
  });

  it('marca LOSS quando a 13a vela fecha abaixo da abertura', async () => {
    const broker = new MockBrokerAdapter();
    await broker.authenticate();
    const activeId = 76;
    const candles = buildOccurrences(activeId, safeDayStart(), 1, false);
    broker.seedCandles(activeId, candles);

    const { occurrences } = await runBacktest(db, broker, [activeId], 30);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]!.result).toBe('LOSS');
  });

  it('Gale 1 combinado: WIN da 1a entrada passa direto, LOSS usa o resultado da reentrada (candle14)', async () => {
    const broker = new MockBrokerAdapter();
    await broker.authenticate();
    const dayStart = safeDayStart();

    // Ativo A: 1a entrada WIN — nao deveria nem olhar para candle14 (nem existe aqui).
    const winnerActiveId = 81;
    broker.seedCandles(winnerActiveId, buildOccurrences(winnerActiveId, dayStart, 1, true));

    // Ativo B: 1a entrada LOSS + candle14 controlada (fecha ACIMA da abertura).
    const loserActiveId = 76;
    const loserCandles = buildOccurrences(loserActiveId, dayStart, 1, false);
    const candle14From = loserCandles[loserCandles.length - 1]!.to;
    loserCandles.push(green(loserActiveId, candle14From));
    broker.seedCandles(loserActiveId, loserCandles);

    const { summary } = await runBacktest(db, broker, [winnerActiveId, loserActiveId], 30);

    expect(summary.reentry.consideredLosses).toBe(1); // so o ativo B perdeu a 1a entrada
    expect(summary.reentry.missingCandle14).toBe(0);
    // Gale CALL: WIN direto (ativo A) + candle14 do ativo B fechou em alta -> WIN tambem = 2 wins.
    expect(summary.reentry.combinedSameDirection).toEqual({ wins: 2, losses: 0, dojis: 0 });
    // Gale PUT: WIN direto (ativo A) passa igual, mas o gale em PUT no candle14 em alta perde.
    expect(summary.reentry.combinedOppositeDirection).toEqual({ wins: 1, losses: 1, dojis: 0 });
  });

  it('perDay inclui dias sem nenhum sinal (bucket NONE) para todo o periodo pedido', async () => {
    const broker = new MockBrokerAdapter();
    await broker.authenticate();
    const activeId = 2298;
    broker.seedCandles(activeId, []); // nenhum candle historico -> nenhuma ocorrencia

    const { summary } = await runBacktest(db, broker, [activeId], 3);
    expect(summary.perDay.length).toBeGreaterThanOrEqual(3);
    expect(summary.perDay.every((d) => d.bucket === 'NONE' && d.total === 0)).toBe(true);
  });
});
