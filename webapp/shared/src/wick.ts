import type { Candle } from './types.js';

/**
 * Calcula o percentual do pavio inferior de um candle.
 * range = high - low
 * lowerWick = min(open, close) - low
 * lowerWickPercentage = lowerWick / range
 *
 * Retorna null quando high === low (candle degenerado — nao da pra medir pavio, deve ser
 * tratado como reprovando a regra do pavio, nunca como 0% nem 100%).
 */
export function lowerWickPercentage(c: Pick<Candle, 'open' | 'high' | 'low' | 'close'>): number | null {
  const range = c.high - c.low;
  if (range === 0) return null;
  const lowerWick = Math.min(c.open, c.close) - c.low;
  return lowerWick / range;
}

/** Analogo a lowerWickPercentage, mas para o pavio SUPERIOR: upperWick = high - max(open, close). */
export function upperWickPercentage(c: Pick<Candle, 'open' | 'high' | 'low' | 'close'>): number | null {
  const range = c.high - c.low;
  if (range === 0) return null;
  const upperWick = c.high - Math.max(c.open, c.close);
  return upperWick / range;
}

/** Corpo da vela como fracao do seu proprio range (0 = doji perfeito, 1 = sem pavio nenhum). */
export function bodyPercentage(c: Pick<Candle, 'open' | 'high' | 'low' | 'close'>): number | null {
  const range = c.high - c.low;
  if (range === 0) return null;
  return Math.abs(c.close - c.open) / range;
}
