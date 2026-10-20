import { describe, expect, it } from 'vitest';
import type { Candle } from '@polarium12c/shared';
import { bollingerBands, cci, zigzagPivots } from '@polarium12c/shared';

const ACTIVE = 81;
const SIZE = 60;
const BASE = 1_800_000_000;

function candle(from: number, open: number, high: number, low: number, close: number): Candle {
  return { activeId: ACTIVE, size: SIZE, from, to: from + SIZE, open, high, low, close, isClosed: true };
}

/** Candle "achatado": open=close=price, high/low com uma folga minuscula so pra nao ter range 0. */
function flat(from: number, price: number): Candle {
  return candle(from, price, price + 0.01, price - 0.01, price);
}

describe('zigzagPivots', () => {
  it('nao marca nada quando o preco nunca se move o suficiente pra bater o limiar', () => {
    let from = BASE;
    const candles: Candle[] = [];
    for (let i = 0; i < 10; i++) {
      candles.push(flat(from, 100 + (i % 2 === 0 ? 0.1 : -0.1))); // oscilacao de 0.1, bem abaixo de 5%
      from += SIZE;
    }
    expect(zigzagPivots(candles, 0.05)).toEqual([]);
  });

  it('confirma um fundo quando o preco cai 5%+ e depois sobe 5%+ de volta', () => {
    let from = BASE;
    const candles: Candle[] = [flat(from, 100)];
    from += SIZE;
    candles.push(candle(from, 100, 100, 90, 91)); // cai pra 90 (-10%, confirma trend down)
    from += SIZE;
    candles.push(candle(from, 91, 96, 91, 95)); // sobe pra 96 (+6.7% de 90) — confirma o fundo em 90
    from += SIZE;

    const pivots = zigzagPivots(candles, 0.05);
    expect(pivots).toHaveLength(1);
    expect(pivots[0]!.type).toBe('low');
    expect(pivots[0]!.price).toBe(90);
    expect(pivots[0]!.confirmedAt).toBe(2); // so confirmado na 3a vela (indice 2), nao na propria vela do fundo
  });

  it('confirma topo e fundo em sequencia (zigzag alternando)', () => {
    let from = BASE;
    const candles: Candle[] = [flat(from, 100)];
    from += SIZE;
    candles.push(candle(from, 100, 112, 100, 110)); // sobe pra 112 (+12%) — confirma trend up
    from += SIZE;
    candles.push(candle(from, 110, 110, 100, 101)); // cai pra 100 (-10.7% de 112) — confirma o topo em 112
    from += SIZE;
    candles.push(candle(from, 101, 112, 101, 110)); // sobe de volta pra 112 (+12% de 100) — confirma o fundo em 100
    from += SIZE;

    const pivots = zigzagPivots(candles, 0.05);
    expect(pivots.map((p) => p.type)).toEqual(['high', 'low']);
    expect(pivots[0]!.price).toBe(112);
    expect(pivots[1]!.price).toBe(100);
  });
});

describe('cci', () => {
  it('fica em torno de 0 quando o preco tipico esta estavel (sem desvio da media)', () => {
    let from = BASE;
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push(flat(from, 100));
      from += SIZE;
    }
    const values = cci(candles, 14);
    expect(values[13]).not.toBeNull();
    expect(values[19]!).toBeCloseTo(0, 5);
  });

  it('fica bem negativo quando o preco despenca abaixo de uma janela estavel', () => {
    let from = BASE;
    const candles: Candle[] = [];
    for (let i = 0; i < 13; i++) {
      candles.push(flat(from, 100));
      from += SIZE;
    }
    candles.push(candle(from, 92, 93, 90, 91)); // ultima vela: bem abaixo da janela estavel
    const values = cci(candles, 14);
    expect(values[13]!).toBeLessThan(-100);
  });

  it('devolve null antes de ter velas suficientes para o periodo', () => {
    let from = BASE;
    const candles: Candle[] = [flat(from, 100), flat(from + SIZE, 100)];
    const values = cci(candles, 14);
    expect(values.every((v) => v === null)).toBe(true);
  });
});

describe('bollingerBands', () => {
  it('banda inferior fica bem acima de um preco que despencou (fechamento alem da banda)', () => {
    let from = BASE;
    const candles: Candle[] = [];
    for (let i = 0; i < 19; i++) {
      candles.push(flat(from, 102)); // 19 velas estaveis em 102 — variancia quase zero
      from += SIZE;
    }
    candles.push(candle(from, 92, 93, 90, 92.8)); // 20a vela: despenca
    const bands = bollingerBands(candles, 20, 2);
    const last = bands[19]!;
    expect(last).not.toBeNull();
    expect(candles[19]!.close).toBeLessThan(last.lower);
  });

  it('devolve null antes de ter velas suficientes para o periodo', () => {
    let from = BASE;
    const candles: Candle[] = [flat(from, 100), flat(from + SIZE, 100)];
    const bands = bollingerBands(candles, 20, 2);
    expect(bands.every((b) => b === null)).toBe(true);
  });
});
