import type { Candle } from './types.js';

/**
 * Calcula o percentual do pavio inferior de um candle.
 * range = high - low
 * lowerWick = min(open, close) - low
 * lowerWickPercentage = lowerWick / range
 *
 * Retorna null quando high === low (candle invalido para esta regra — deve invalidar
 * a sequencia, nunca ser tratado como 0% nem 100%).
 */
export function lowerWickPercentage(c: Pick<Candle, 'open' | 'high' | 'low' | 'close'>): number | null {
  const range = c.high - c.low;
  if (range === 0) return null;
  const lowerWick = Math.min(c.open, c.close) - c.low;
  return lowerWick / range;
}
