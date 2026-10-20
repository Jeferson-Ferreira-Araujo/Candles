import type { Candle } from './types.js';

/**
 * Indicadores tecnicos puros (sem IO, sem estado) usados pela estrategia de Suporte e
 * Resistencia (ver classicStrategies.ts). Cada funcao le um array de candles FECHADOS,
 * ordenados do mais antigo pro mais recente, e nunca olha pra frente do indice que esta
 * calculando — importante pra nao vazar informacao do futuro pro backtest/deteccao de sinal.
 */

export interface ZigzagPivot {
  /** Indice (no array de candles) onde o topo/fundo de fato aconteceu. */
  index: number;
  price: number;
  type: 'high' | 'low';
  /** Indice em que o pivo foi CONFIRMADO (so se sabe que foi um topo/fundo depois da reversao
   * seguinte bater o limiar) — usar isso, nunca `index`, pra decidir se um pivo "ja era conhecido"
   * num certo ponto do historico, senao vaza informacao do futuro. */
  confirmedAt: number;
}

/**
 * Zigzag classico: so marca um novo topo/fundo quando o preco reverte pelo menos `thresholdPct`
 * (fracao, ex.: 0.05 = 5%) a partir do extremo anterior. Filtra ruido de pequenas oscilacoes,
 * deixando so os topos/fundos realmente relevantes — a base pra identificar niveis de
 * suporte/resistencia que o mercado de fato respeitou.
 */
export function zigzagPivots(candles: Candle[], thresholdPct: number): ZigzagPivot[] {
  if (candles.length < 2) return [];
  const pivots: ZigzagPivot[] = [];
  let trend: 'up' | 'down' | null = null;
  let extremeIndex = 0;
  let extremePrice = candles[0]!.close;

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    if (trend === null) {
      if (c.high >= extremePrice * (1 + thresholdPct)) {
        trend = 'up';
        extremeIndex = i;
        extremePrice = c.high;
      } else if (c.low <= extremePrice * (1 - thresholdPct)) {
        trend = 'down';
        extremeIndex = i;
        extremePrice = c.low;
      }
      continue;
    }
    if (trend === 'up') {
      if (c.high > extremePrice) {
        extremePrice = c.high;
        extremeIndex = i;
      } else if (c.low <= extremePrice * (1 - thresholdPct)) {
        pivots.push({ index: extremeIndex, price: extremePrice, type: 'high', confirmedAt: i });
        trend = 'down';
        extremePrice = c.low;
        extremeIndex = i;
      }
    } else {
      if (c.low < extremePrice) {
        extremePrice = c.low;
        extremeIndex = i;
      } else if (c.high >= extremePrice * (1 + thresholdPct)) {
        pivots.push({ index: extremeIndex, price: extremePrice, type: 'low', confirmedAt: i });
        trend = 'up';
        extremePrice = c.high;
        extremeIndex = i;
      }
    }
  }
  return pivots;
}

/**
 * CCI (Commodity Channel Index) — mede a "velocidade"/momentum do preco em relacao a sua media
 * recente. Preco tipico (H+L+C)/3, desvio medio absoluto em vez de desvio padrao (formula
 * classica de Lambert). > +100 = sobrecomprado/movimento esticado pra cima; < -100 =
 * sobrevendido/esticado pra baixo. `null` onde nao ha velas suficientes ainda.
 */
export function cci(candles: Candle[], period: number): (number | null)[] {
  const typicalPrices = candles.map((c) => (c.high + c.low + c.close) / 3);
  const out: (number | null)[] = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    const window = typicalPrices.slice(i - period + 1, i + 1);
    const sma = window.reduce((a, b) => a + b, 0) / period;
    const meanDeviation = window.reduce((a, b) => a + Math.abs(b - sma), 0) / period;
    out[i] = meanDeviation === 0 ? 0 : (typicalPrices[i]! - sma) / (0.015 * meanDeviation);
  }
  return out;
}

export interface BollingerBand {
  upper: number;
  middle: number;
  lower: number;
}

/**
 * Bandas de Bollinger — mede a "variacao"/volatilidade do preco: media movel simples +/- N
 * desvios padrao do fechamento. Preco perto/alem de uma banda indica um movimento esticado em
 * relacao a volatilidade recente. `null` onde nao ha velas suficientes ainda.
 */
export function bollingerBands(candles: Candle[], period: number, stdDevMultiplier: number): (BollingerBand | null)[] {
  const closes = candles.map((c) => c.close);
  const out: (BollingerBand | null)[] = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    const window = closes.slice(i - period + 1, i + 1);
    const mean = window.reduce((a, b) => a + b, 0) / period;
    const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    const stdDev = Math.sqrt(variance);
    out[i] = { upper: mean + stdDevMultiplier * stdDev, middle: mean, lower: mean - stdDevMultiplier * stdDev };
  }
  return out;
}
