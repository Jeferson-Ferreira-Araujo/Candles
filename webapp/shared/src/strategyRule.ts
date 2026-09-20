import type { CandleColor, PatternDisplayState } from './types.js';

/**
 * Regra "12 Candles" — CONGELADA. Nao alterar nem otimizar (fora das mudancas explicitamente
 * pedidas aqui, versionadas ao longo do tempo pelo usuario).
 *
 * Reduzida para 8 velas (decisao do usuario: esse prefixo de 8 cores apareceu em toda
 * ocorrencia observada nas rodadas anteriores de 12+ velas, entao virou a regra inteira):
 *
 * G R G R R G R R
 *
 * - Sinal de confirmacao: a propria 8a vela fechando (sem checagem de pavio — a vela
 *   "pavio 11" nao existe mais nesse tamanho de padrao, ver WICK_RULE_APPLIES abaixo).
 * - Apos a 8a vela FECHAR, o sinal e ENTRY_DIRECTION (PUT) na 9a vela. Sem gale na entrada
 *   oficial — a analise (backtest) ainda simula os dois lados do Gale 1 para comparacao.
 *
 * O nome do array/constante (TWELVE_CANDLES_PATTERN) e os campos candle13/candle14 em
 * PatternOccurrence foram mantidos por estabilidade (schema do banco, tipos ja em uso)
 * mesmo com a regra tendo mudado de tamanho varias vezes.
 */
export const TWELVE_CANDLES_PATTERN: readonly CandleColor[] = ['G', 'R', 'G', 'R', 'R', 'G', 'R', 'R'];

export const PATTERN_LENGTH = TWELVE_CANDLES_PATTERN.length; // 8
export const WICK_ELEVENTH_INDEX = 10; // posicao 11 (1-based) = index 10 (0-based) — posicao fixa, historica
export const WICK_11_MIN_PERCENTAGE = 0.25;
/**
 * Se a regra atual e longa o bastante para conter a posicao do pavio da 11a vela. Quando
 * false (como na regra de 8 velas de hoje), o motor pula inteiramente a checagem de pavio —
 * nao ha vela nessa posicao para medir.
 */
export const WICK_RULE_APPLIES = WICK_ELEVENTH_INDEX < PATTERN_LENGTH;

/** Direcao da entrada na vela seguinte a confirmacao — unica fonte de verdade (nao hardcodar 'PUT'/'CALL' em outro lugar). */
export const ENTRY_DIRECTION = 'PUT' as const;

if (WICK_RULE_APPLIES && TWELVE_CANDLES_PATTERN[WICK_ELEVENTH_INDEX] !== 'R') {
  throw new Error('Invariante quebrada: quando aplicavel, a 11a posicao da regra precisa ser R.');
}

/**
 * Estado de exibicao do card de monitor, derivado do tamanho do prefixo casado — relativo a
 * PATTERN_LENGTH (nao a numeros fixos), entao continua correto conforme a regra muda de
 * tamanho. Quando o pavio da 11a nao se aplica (regra mais curta que isso), ATENCAO/PRE_SINAL
 * nunca disparam e so resta um ACOMPANHANDO generico um passo antes de confirmar.
 */
export function patternDisplayState(matchedLength: number): PatternDisplayState {
  if (matchedLength >= PATTERN_LENGTH) return 'CONFIRMADO';
  if (WICK_RULE_APPLIES) {
    if (matchedLength === PATTERN_LENGTH - 1) return 'PRE_SINAL';
    if (matchedLength === WICK_ELEVENTH_INDEX) return 'ATENCAO';
    if (matchedLength === WICK_ELEVENTH_INDEX - 1) return 'ACOMPANHANDO';
  } else if (matchedLength === PATTERN_LENGTH - 1) {
    return 'ACOMPANHANDO';
  }
  return 'MONITORANDO';
}
