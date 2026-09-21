import { describe, expect, it } from 'vitest';
import type { Candle } from '@polarium12c/shared';
import { discoverPatterns, DISCOVERY_MIN_DAILY_REPEATS } from '../src/discovery/patternDiscovery.js';

const SIZE = 60;
const ACTIVE = 81;
const DAY_SECONDS = 24 * 60 * 60;

function green(from: number): Candle {
  return { activeId: ACTIVE, size: SIZE, from, to: from + SIZE, open: 1, close: 2, high: 2, low: 1, isClosed: true };
}
function red(from: number): Candle {
  return { activeId: ACTIVE, size: SIZE, from, to: from + SIZE, open: 2, close: 1, high: 2, low: 1, isClosed: true };
}
/** Vela com pavio inferior controlado (fracao do range, 0..1). */
function withWick(from: number, color: 'G' | 'R', wickFraction: number): Candle {
  return color === 'G'
    ? { activeId: ACTIVE, size: SIZE, from, to: from + SIZE, open: wickFraction * 100, close: 100, high: 100, low: 0, isClosed: true }
    : { activeId: ACTIVE, size: SIZE, from, to: from + SIZE, open: 100, close: wickFraction * 100, high: 100, low: 0, isClosed: true };
}
function doji(from: number): Candle {
  return { activeId: ACTIVE, size: SIZE, from, to: from + SIZE, open: 5, close: 5, high: 6, low: 4, isClosed: true };
}

/**
 * Repete a sequencia de cores (G/R) `count` vezes, cada repeticao ISOLADA por um DOJI, num
 * unico dia. O isolamento e proposital: sem ele, repetir uma sequencia periodica (ex.: G,R,G,R)
 * de ponta a ponta forma uma corrida continua onde toda janela deslizante casa (nao so nos
 * limites de cada repeticao), o que mistura o pavio controlado com velas de outras posicoes.
 */
function repeatSequence(dayStart: number, sequence: ('G' | 'R')[], count: number, wickFraction = 0.5): Candle[] {
  const candles: Candle[] = [];
  let from = dayStart;
  for (let n = 0; n < count; n++) {
    sequence.forEach((color, i) => {
      const isSignal = i === sequence.length - 2; // penultima vela
      candles.push(isSignal ? withWick(from, color, wickFraction) : color === 'G' ? green(from) : red(from));
      from += SIZE;
    });
    candles.push(doji(from));
    from += SIZE;
  }
  return candles;
}

describe('discoverPatterns', () => {
  it('encontra uma sequencia de 4 velas que se repete pelo menos 10 vezes no mesmo dia', () => {
    const dayStart = 1_700_000_000;
    const candles = repeatSequence(dayStart, ['G', 'R', 'G', 'R'], DISCOVERY_MIN_DAILY_REPEATS);

    const results = discoverPatterns(candles);
    const found = results.find((p) => p.sequence.join('') === 'GRGR');
    expect(found).toBeDefined();
    expect(found!.length).toBe(4);
    expect(found!.bestDayCount).toBeGreaterThanOrEqual(DISCOVERY_MIN_DAILY_REPEATS);
    expect(found!.avgSignalWickPercentage).toBeCloseTo(0.5);
    expect(found!.validSignalWickShare).toBe(1); // pavio 50% >= minimo de 25%
  });

  it('descarta sequencias que se repetem menos que o minimo exigido no mesmo dia', () => {
    const dayStart = 1_700_000_000;
    const candles = repeatSequence(dayStart, ['G', 'G', 'R', 'R'], DISCOVERY_MIN_DAILY_REPEATS - 1);

    const results = discoverPatterns(candles);
    expect(results.find((p) => p.sequence.join('') === 'GGRR')).toBeUndefined();
  });

  it('nao conta repeticoes espalhadas em dias diferentes como se fossem do mesmo dia', () => {
    const day1 = 1_700_000_000;
    const day2 = day1 + DAY_SECONDS;
    // 6 repeticoes num dia, 6 no outro — nenhum dos dois isolado bate os 10 exigidos, mas o total (12) bateria se fosse somado errado.
    const candles = [
      ...repeatSequence(day1, ['R', 'G', 'R', 'G'], 6),
      ...repeatSequence(day2, ['R', 'G', 'R', 'G'], 6),
    ];

    const results = discoverPatterns(candles);
    expect(results.find((p) => p.sequence.join('') === 'RGRG')).toBeUndefined();
  });

  it('um candle DOJI quebra a sequencia (nunca faz parte de um padrao)', () => {
    const dayStart = 1_700_000_000;
    const candles: Candle[] = [];
    let from = dayStart;
    for (let n = 0; n < DISCOVERY_MIN_DAILY_REPEATS; n++) {
      candles.push(green(from));
      from += SIZE;
      candles.push(withWick(from, 'R', 0.5));
      from += SIZE;
      candles.push(green(from));
      from += SIZE;
      candles.push(withWick(from, 'R', 0.5));
      from += SIZE;
      candles.push(doji(from)); // separa cada repeticao com um doji
      from += SIZE;
    }

    const results = discoverPatterns(candles);
    // GRGR aparece isolada entre dojis — nunca formaria uma janela continua maior que 4, mas
    // as 10 ocorrencias de exatamente "GRGR" ainda devem ser contadas (o doji so impede
    // janelas que o *atravessariam*).
    const found = results.find((p) => p.sequence.join('') === 'GRGR');
    expect(found).toBeDefined();
    expect(found!.bestDayCount).toBe(DISCOVERY_MIN_DAILY_REPEATS);
  });

  it('ignora sequencias menores que 4 velas mesmo que se repitam muito', () => {
    const dayStart = 1_700_000_000;
    const candles = repeatSequence(dayStart, ['G', 'R'], 50);
    const results = discoverPatterns(candles);
    expect(results.every((p) => p.length >= 4)).toBe(true);
  });
});
