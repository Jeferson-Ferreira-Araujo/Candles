import type { CandleColor } from './types.js';

/**
 * Regra "12 Candles" — CONGELADA. Nao alterar nem otimizar.
 *
 * Extensao experimental para 14 velas (decisao do usuario, testando entrada COMPRADA/CALL
 * sem gale): o nome do array/constante foi mantido por estabilidade (schema do banco, ids
 * historicos), mas a regra completa hoje e:
 *
 * G R G R R G R R R R R G G R
 *
 * - Posicao 11 (index 10) precisa ser R com pavio inferior >= WICK_11_MIN_PERCENTAGE (igual
 *   a antes, inalterado por todas as extensoes).
 * - Posicao 13 (index 12) precisa ser G.
 * - Posicao 14 (index 13, a NOVA ultima posicao) precisa ser R — e o sinal de confirmacao.
 * - Apos a 14a vela FECHAR, o sinal e ENTRY_DIRECTION (CALL) na 15a vela. Sem gale.
 */
export const TWELVE_CANDLES_PATTERN: readonly CandleColor[] = [
  'G', 'R', 'G', 'R', 'R', 'G', 'R', 'R', 'R', 'R', 'R', 'G', 'G', 'R',
];

export const PATTERN_LENGTH = TWELVE_CANDLES_PATTERN.length; // 14
export const WICK_ELEVENTH_INDEX = 10; // posicao 11 (1-based) = index 10 (0-based) — inalterado
export const WICK_11_MIN_PERCENTAGE = 0.25;
/** Direcao da entrada na vela seguinte a confirmacao — unica fonte de verdade (nao hardcodar 'PUT'/'CALL' em outro lugar). */
export const ENTRY_DIRECTION = 'CALL' as const;

if (TWELVE_CANDLES_PATTERN[WICK_ELEVENTH_INDEX] !== 'R') {
  throw new Error('Invariante quebrada: a 11a posicao da regra precisa ser R.');
}
if (TWELVE_CANDLES_PATTERN[PATTERN_LENGTH - 1] !== 'R') {
  throw new Error('Invariante quebrada: a ultima posicao da regra (14a) precisa ser R.');
}
