import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Candle, CandleColor, Direction } from '@polarium12c/shared';
import { getTestDb, resetDb } from './helpers/testDb.js';
import { MockBrokerAdapter } from '../src/broker/MockBrokerAdapter.js';
import { runBacktest } from '../src/backtest/backtestRunner.js';
import { listBacktestOccurrences } from '../src/db/repositories.js';
import type { Db } from '../src/db/db.js';

const SIZE = 60;

/** Padrao de teste (prefixo de confirmacao, NAO inclui a vela de entrada) + direcao de entrada. */
const CONFIRM_PATTERN: CandleColor[] = ['G', 'R', 'G', 'R', 'R', 'G', 'R', 'R'];
const DIRECTION: Direction = 'PUT';

function green(activeId: number, from: number): Candle {
  return { activeId, size: SIZE, from, to: from + SIZE, open: 1, close: 2, high: 2, low: 1, isClosed: true };
}
function red(activeId: number, from: number): Candle {
  return { activeId, size: SIZE, from, to: from + SIZE, open: 2, close: 1, high: 2, low: 1, isClosed: true };
}
/** Vela com pavio inferior controlado (fracao do range, 0..1) — usada para a vela de sinal (regra final de pavio). */
function withWick(activeId: number, from: number, color: CandleColor, wickFraction: number): Candle {
  return color === 'G'
    ? { activeId, size: SIZE, from, to: from + SIZE, open: wickFraction * 100, close: 100, high: 100, low: 0, isClosed: true }
    : { activeId, size: SIZE, from, to: from + SIZE, open: 100, close: wickFraction * 100, high: 100, low: 0, isClosed: true };
}

/**
 * Constroi N ocorrencias consecutivas e nao sobrepostas do padrao completo (CONFIRM_PATTERN.length
 * velas do padrao + 1 vela de entrada). A ULTIMA vela do padrao (a de sinal) sempre leva um
 * pavio de 50% (acima do minimo de 25% exigido pela regra final), para nao reprovar por padrao
 * em testes que nao estao testando essa regra especificamente. A entrada e sempre DIRECTION
 * (PUT) — entao `entryCandleUp=true` (vela de entrada verde) produz LOSS, e `false` (vermelha)
 * produz WIN.
 */
function buildOccurrences(activeId: number, baseFrom: number, count: number, entryCandleUp: boolean): Candle[] {
  const candles: Candle[] = [];
  let from = baseFrom;
  for (let n = 0; n < count; n++) {
    CONFIRM_PATTERN.forEach((color, i) => {
      const isSignal = i === CONFIRM_PATTERN.length - 1;
      candles.push(isSignal ? withWick(activeId, from, color, 0.5) : color === 'G' ? green(activeId, from) : red(activeId, from));
      from += SIZE;
    });
    // Vela de entrada (candle13 no tipo PatternOccurrence) + 1 candle "separador" neutro para
    // nao encostar na proxima ocorrencia.
    candles.push(entryCandleUp ? green(activeId, from) : red(activeId, from));
    from += SIZE;
  }
  return candles;
}

/**
 * Ancora um timestamp SEMPRE no passado (nunca no futuro relativo a `Date.now()`, que e o
 * limite superior que runBacktest usa para buscar historico) e longe o suficiente de uma
 * virada de dia UTC para que nenhuma sequencia curta de candles construida a partir dele
 * possa atravessar meia-noite.
 *
 * Ancorar direto em "02:00 UTC de hoje" (versao anterior) e fragil de duas formas opostas:
 * perto da meia-noite UTC isso pode cair no dia ANTERIOR (quebra testes que dependem de duas
 * ocorrencias no mesmo dia), e ENTRE meia-noite e ~02h UTC isso cai no FUTURO relativo a
 * `now()` — os candles sinteticos ficam fora da janela `to=now` do runBacktest e o teste ve
 * zero ocorrencias (exatamente o que aconteceu rodando este teste as ~01h40 UTC).
 *
 * Corrigido ancorando 6h no passado e so entao arredondando para as 02:00 UTC do dia desse
 * ponto — no pior caso (ancora logo antes da meia-noite do seu proprio dia) isso ainda fica
 * pelo menos ~4h antes de `now()`, nunca no futuro.
 */
function safeDayStart(): number {
  const now = Math.floor(Date.now() / 1000);
  const sixHoursAgo = now - 6 * 60 * 60;
  const thatDayMidnightUtc = Math.floor(sixHoursAgo / 86_400) * 86_400;
  return thatDayMidnightUtc + 2 * 60 * 60; // 02:00 UTC do dia de "6h atras"
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

  it('detecta multiplas ocorrencias, calcula WIN/LOSS pela vela de entrada (PUT), e separa "todas" de "primeira do dia"', async () => {
    const broker = new MockBrokerAdapter();
    await broker.authenticate();

    // Precisa cair dentro da janela real de `days` (30) a partir de agora, ja que
    // runBacktest usa Date.now() internamente — nao um dia fixo no passado.
    const dayStart = safeDayStart();
    const activeId = 81;

    // 2 ocorrencias no mesmo "dia logico" do teste (nao precisa ser exatamente 1 dia UTC
    // real aqui, so precisamos de >=2 ocorrencias no total para testar a separacao).
    // Entrada vermelha (fecha abaixo da abertura) -> PUT ganha.
    const candles = buildOccurrences(activeId, dayStart, 2, false);
    broker.seedCandles(activeId, candles);

    const { occurrences, summary } = await runBacktest(db, broker, [activeId], 30, CONFIRM_PATTERN, DIRECTION);

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

  it('marca LOSS quando a vela de entrada (PUT) fecha ACIMA da abertura', async () => {
    const broker = new MockBrokerAdapter();
    await broker.authenticate();
    const activeId = 76;
    const candles = buildOccurrences(activeId, safeDayStart(), 1, true);
    broker.seedCandles(activeId, candles);

    const { occurrences } = await runBacktest(db, broker, [activeId], 30, CONFIRM_PATTERN, DIRECTION);
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0]!.result).toBe('LOSS');
  });

  it('Gale 1 combinado: WIN da 1a entrada (PUT) passa direto, LOSS usa o resultado da reentrada (candle14)', async () => {
    const broker = new MockBrokerAdapter();
    await broker.authenticate();
    const dayStart = safeDayStart();

    // Ativo A: 1a entrada (PUT) WIN — vela de entrada vermelha. Nao deveria nem olhar para candle14 (nem existe aqui).
    const winnerActiveId = 81;
    broker.seedCandles(winnerActiveId, buildOccurrences(winnerActiveId, dayStart, 1, false));

    // Ativo B: 1a entrada (PUT) LOSS — vela de entrada verde — + candle14 controlada (fecha ACIMA da abertura).
    const loserActiveId = 76;
    const loserCandles = buildOccurrences(loserActiveId, dayStart, 1, true);
    const candle14From = loserCandles[loserCandles.length - 1]!.to;
    loserCandles.push(green(loserActiveId, candle14From));
    broker.seedCandles(loserActiveId, loserCandles);

    const { summary } = await runBacktest(db, broker, [winnerActiveId, loserActiveId], 30, CONFIRM_PATTERN, DIRECTION);

    expect(summary.reentry.consideredLosses).toBe(1); // so o ativo B perdeu a 1a entrada
    expect(summary.reentry.missingCandle14).toBe(0);
    // Gale mesma direcao (PUT): WIN direto (ativo A) + candle14 do ativo B em alta -> PUT perde = 1 win, 1 loss.
    expect(summary.reentry.combinedSameDirection).toEqual({ wins: 1, losses: 1, dojis: 0 });
    // Gale direcao contraria (CALL): WIN direto (ativo A) passa igual + candle14 em alta -> CALL ganha = 2 wins.
    expect(summary.reentry.combinedOppositeDirection).toEqual({ wins: 2, losses: 0, dojis: 0 });
    // Isolado (SO o ativo B, sem misturar o win direto do ativo A): candle14 em alta -> PUT perde, CALL ganha.
    expect(summary.reentry.reentryOnlySameDirection).toEqual({ wins: 0, losses: 1, dojis: 0 });
    expect(summary.reentry.reentryOnlyOppositeDirection).toEqual({ wins: 1, losses: 0, dojis: 0 });
  });

  it('perDay inclui dias sem nenhum sinal (bucket NONE) para todo o periodo pedido', async () => {
    const broker = new MockBrokerAdapter();
    await broker.authenticate();
    const activeId = 2298;
    broker.seedCandles(activeId, []); // nenhum candle historico -> nenhuma ocorrencia

    const { summary } = await runBacktest(db, broker, [activeId], 3, CONFIRM_PATTERN, DIRECTION);
    expect(summary.perDay.length).toBeGreaterThanOrEqual(3);
    expect(summary.perDay.every((d) => d.bucket === 'NONE' && d.total === 0)).toBe(true);
  });
});
