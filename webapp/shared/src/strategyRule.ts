import type { CandleColor } from './types.js';

/**
 * Regra "12 Candles" — CONGELADA. Nao alterar nem otimizar.
 *
 * Atualizada para a extensao de 13 velas (decisao do usuario, com base em resultados reais
 * de reentrada em PUT observados na analise): o nome do array/constante foi mantido por
 * estabilidade (schema do banco, ids historicos), mas a regra completa hoje e:
 *
 * G R G R R G R R R R R G G
 *
 * - Posicao 11 (index 10) precisa ser R com pavio inferior >= WICK_11_MIN_PERCENTAGE (igual
 *   a antes).
 * - Posicao 13 (index 12, a NOVA ultima posicao) precisa ser G — e o sinal de confirmacao.
 * - Apos a 13a vela FECHAR, o sinal e ENTRY_DIRECTION (PUT) na 14a vela.
 */
export const TWELVE_CANDLES_PATTERN: readonly CandleColor[] = [
  'G', 'R', 'G', 'R', 'R', 'G', 'R', 'R', 'R', 'R', 'R', 'G', 'G',
];

export const PATTERN_LENGTH = TWELVE_CANDLES_PATTERN.length; // 13
export const WICK_ELEVENTH_INDEX = 10; // posicao 11 (1-based) = index 10 (0-based) — inalterado
export const WICK_11_MIN_PERCENTAGE = 0.25;
/** Direcao da entrada na vela seguinte a confirmacao — unica fonte de verdade (nao hardcodar 'PUT'/'CALL' em outro lugar). */
export const ENTRY_DIRECTION = 'PUT' as const;

if (TWELVE_CANDLES_PATTERN[WICK_ELEVENTH_INDEX] !== 'R') {
  throw new Error('Invariante quebrada: a 11a posicao da regra precisa ser R.');
}
if (TWELVE_CANDLES_PATTERN[PATTERN_LENGTH - 1] !== 'G') {
  throw new Error('Invariante quebrada: a ultima posicao da regra (13a) precisa ser G.');
}
