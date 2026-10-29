import { describe, expect, it } from 'vitest';
import type { Candle } from '@polarium12c/shared';
import { defaultClassicStrategyConfig } from '@polarium12c/shared';
import { detectStrategyProgress } from '../src/strategies/classicStrategies.js';

const ACTIVE = 81;
const SIZE = 60;
const BASE = 1_800_000_000;

function candle(from: number, open: number, high: number, low: number, close: number): Candle {
  return { activeId: ACTIVE, size: SIZE, from, to: from + SIZE, open, high, low, close, isClosed: true };
}

describe('detectStrategyProgress — three_soldiers', () => {
  const strategy = defaultClassicStrategyConfig('three_soldiers');

  it('sobe de estagio 1 pra 3 conforme cada "soldado" fecha, fica pronta na 3a vela', () => {
    let from = BASE;
    const candles: Candle[] = [];
    const push = (open: number, high: number, low: number, close: number) => {
      candles.push(candle(from, open, high, low, close));
      from += SIZE;
    };

    expect(detectStrategyProgress(candles, strategy)).toBeNull();

    push(10, 102, 10, 100); // 1a vela do trio
    expect(detectStrategyProgress(candles, strategy)).toEqual({
      stage: 1,
      totalStages: 3,
      direction: 'CALL', // a cor do trio ja indica a direcao, mesmo so com 1 vela em pe
      readyNow: false,
      setupCandleTimes: [BASE],
    });

    push(100, 152, 100, 150); // 2a, fecha mais alto
    expect(detectStrategyProgress(candles, strategy)).toEqual({
      stage: 2,
      totalStages: 3,
      direction: 'CALL',
      readyNow: false,
      setupCandleTimes: [BASE, BASE + SIZE],
    });

    push(150, 202, 150, 200); // 3a, fecha mais alto ainda -> pronta
    expect(detectStrategyProgress(candles, strategy)).toEqual({
      stage: 3,
      totalStages: 3,
      direction: 'CALL',
      readyNow: true,
      setupCandleTimes: [BASE, BASE + SIZE, BASE + SIZE * 2],
    });
  });

  it('nao acusa nada quando nenhuma vela do padrao comecou', () => {
    let from = BASE;
    const candles: Candle[] = [candle(from, 100, 102, 98, 99)]; // corpo fraco, nao qualifica
    expect(detectStrategyProgress(candles, strategy)).toBeNull();
  });
});

describe('detectStrategyProgress — estrategias binarias (sem contagem de velas)', () => {
  it('support_resistance nunca mostra estagio parcial — so aparece quando pronta', () => {
    const strategy = defaultClassicStrategyConfig('support_resistance');
    let from = BASE;
    const candles: Candle[] = [];
    for (let i = 0; i < 30; i++) {
      candles.push(candle(from, 100, 100.3, 99.7, 100));
      from += SIZE;
    }
    // Historico estavel, sem nivel validado nem CCI/Bollinger esticados — nada pendente.
    expect(detectStrategyProgress(candles, strategy)).toBeNull();
  });
});
