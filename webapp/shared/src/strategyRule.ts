import type { CandleColor } from './types.js';

/**
 * Regra "12 Candles" — CONGELADA. Nao alterar nem otimizar.
 * G R G R R G R R R R R G
 * Posicao 11 (index 10) precisa ser R com pavio inferior >= WICK_11_MIN_PERCENTAGE.
 * Apos a 12a (index 11, G) FECHAR, o sinal e CALL na 13a.
 */
export const TWELVE_CANDLES_PATTERN: readonly CandleColor[] = [
  'G', 'R', 'G', 'R', 'R', 'G', 'R', 'R', 'R', 'R', 'R', 'G',
];

export const PATTERN_LENGTH = TWELVE_CANDLES_PATTERN.length; // 12
export const WICK_ELEVENTH_INDEX = 10; // posicao 11 (1-based) = index 10 (0-based)
export const WICK_11_MIN_PERCENTAGE = 0.25;

if (TWELVE_CANDLES_PATTERN[WICK_ELEVENTH_INDEX] !== 'R') {
  throw new Error('Invariante quebrada: a 11a posicao da regra 12 Candles precisa ser R.');
}
if (TWELVE_CANDLES_PATTERN[PATTERN_LENGTH - 1] !== 'G') {
  throw new Error('Invariante quebrada: a 12a posicao da regra 12 Candles precisa ser G.');
}
