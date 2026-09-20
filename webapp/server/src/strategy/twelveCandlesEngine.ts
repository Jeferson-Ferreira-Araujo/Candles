import {
  candleColor,
  patternDisplayState,
  PATTERN_LENGTH,
  TWELVE_CANDLES_PATTERN,
  WICK_11_MIN_PERCENTAGE,
  WICK_ELEVENTH_INDEX,
  WICK_RULE_APPLIES,
  lowerWickPercentage,
  type Candle,
  type CandleColor,
  type PatternProgress,
} from '@polarium12c/shared';

/** Sentinela quando WICK_RULE_APPLIES=false: nao ha vela na posicao do pavio pra medir nesse tamanho de regra. */
const WICK_NOT_APPLICABLE = 1;

/**
 * Motor da estrategia "12 Candles". Regra CONGELADA — nao alterar, nao otimizar.
 *
 * Algoritmo: mantem, por ativo, um buffer com os ultimos ate PATTERN_LENGTH candles M1
 * FECHADOS e CONSECUTIVOS (qualquer gap zera o buffer para conter so o candle novo). A cada
 * candle fechado, recalcula do zero o maior L tal que as ULTIMAS L cores do buffer sejam
 * iguais as PRIMEIRAS L posicoes da regra (TWELVE_CANDLES_PATTERN.slice(0, L)). Isso
 * implementa exatamente "procure o maior prefixo da regra que ainda corresponda ao final das
 * velas recebidas" — e, por recalcular do zero a cada tick sobre uma janela deslizante,
 * suporta padroes sobrepostos sem nenhuma logica extra de "continuar apos confirmar". Isso
 * generaliza automaticamente para qualquer PATTERN_LENGTH — a regra ja mudou de tamanho
 * varias vezes sem precisar tocar nesse algoritmo.
 *
 * A regra do pavio da 11a vela SO existe quando WICK_RULE_APPLIES (regra longa o bastante
 * para conter essa posicao) — verificada SOMENTE no momento em que L chega a PATTERN_LENGTH,
 * nunca antes, para nao emitir INVALIDATED duplicado quando o preview em tempo real ja
 * mostrou o percentual. Quando a regra e mais curta que isso (ex.: 8 velas), essa checagem
 * inteira e pulada e a confirmacao acontece direto.
 */

export interface WickPreview {
  currentPercentage: number | null; // null quando high === low ate agora
  requiredPercentage: number;
}

export type TwelveCandlesTick =
  | { kind: 'PROGRESS'; progress: PatternProgress }
  | { kind: 'CONFIRMED'; progress: PatternProgress; window: Candle[]; wickPercentage11: number }
  | { kind: 'INVALIDATED'; progress: PatternProgress; window: Candle[]; reason: 'WICK_BELOW_MINIMUM' | 'ZERO_RANGE'; wickPercentage11: number | null };

interface ActiveState {
  buffer: Candle[]; // ate 12 candles fechados e consecutivos
  matchedLength: number;
}

function colorsOf(candles: Candle[]): CandleColor[] {
  return candles.map((c) => candleColor(c));
}

/** Maior L (0..min(buffer.length, PATTERN_LENGTH)) tal que o final do buffer bate com o inicio da regra. */
function longestMatch(buffer: Candle[]): number {
  const colors = colorsOf(buffer);
  const maxL = Math.min(buffer.length, PATTERN_LENGTH);
  for (let L = maxL; L > 0; L--) {
    const tail = colors.slice(colors.length - L);
    let matches = true;
    for (let i = 0; i < L; i++) {
      if (tail[i] !== TWELVE_CANDLES_PATTERN[i]) {
        matches = false;
        break;
      }
    }
    if (matches) return L;
  }
  return 0;
}

export class TwelveCandlesEngine {
  private states = new Map<number, ActiveState>();

  private getState(activeId: number): ActiveState {
    let s = this.states.get(activeId);
    if (!s) {
      s = { buffer: [], matchedLength: 0 };
      this.states.set(activeId, s);
    }
    return s;
  }

  /**
   * Processa um candle FECHADO. Nunca chamar com um candle ainda em formacao —
   * quem alimenta o engine e responsavel por so repassar candles com isClosed === true.
   */
  onCandleClosed(activeId: number, candle: Candle): TwelveCandlesTick {
    if (!candle.isClosed) {
      throw new Error('TwelveCandlesEngine.onCandleClosed recebeu um candle ainda aberto — isso nunca deve acontecer.');
    }

    const state = this.getState(activeId);
    const last = state.buffer[state.buffer.length - 1];
    const contiguous = last !== undefined && candle.from === last.to;
    const wasAboutToBeEleventh = contiguous && state.matchedLength === WICK_ELEVENTH_INDEX;

    const nextBuffer = contiguous ? [...state.buffer, candle] : [candle];
    const trimmed = nextBuffer.length > PATTERN_LENGTH ? nextBuffer.slice(nextBuffer.length - PATTERN_LENGTH) : nextBuffer;

    // Caso especial: um candle com high === low e SEMPRE um doji (open === close === high
    // === low), entao ele nunca pode ser classificado como 'R' pelo casamento de cores —
    // ou seja, ele nunca chegaria organicamente a ocupar a 11a posicao via longestMatch().
    // Por isso este caso precisa de deteccao dedicada, exatamente no momento em que o
    // candle que ocuparia a 11a posicao fecha, em vez de depender do gate da 12a vela.
    if (wasAboutToBeEleventh && candle.high === candle.low) {
      state.buffer = trimmed;
      state.matchedLength = 0;
      return {
        kind: 'INVALIDATED',
        reason: 'ZERO_RANGE',
        window: trimmed,
        wickPercentage11: null,
        progress: this.buildProgress(activeId, state, 0),
      };
    }

    const matchedLength = longestMatch(trimmed);
    state.buffer = trimmed;
    state.matchedLength = matchedLength;

    if (matchedLength === PATTERN_LENGTH) {
      const window = trimmed.slice(trimmed.length - PATTERN_LENGTH);

      if (!WICK_RULE_APPLIES) {
        // Regra atual e mais curta que a posicao do pavio da 11a — nao ha o que checar,
        // confirma direto.
        return {
          kind: 'CONFIRMED',
          window,
          wickPercentage11: WICK_NOT_APPLICABLE,
          progress: this.buildProgress(activeId, state, PATTERN_LENGTH),
        };
      }

      const eleventh = window[WICK_ELEVENTH_INDEX]!;
      const wickPct = lowerWickPercentage(eleventh);

      if (wickPct === null) {
        // Regra: "Se high == low, invalidar." Reverte a exibicao para ATENCAO (10) —
        // a proxima janela (recalculada do zero no proximo candle) segue livre para achar
        // outro casamento sobreposto.
        state.matchedLength = WICK_ELEVENTH_INDEX;
        return {
          kind: 'INVALIDATED',
          reason: 'ZERO_RANGE',
          window,
          wickPercentage11: null,
          progress: this.buildProgress(activeId, state, WICK_ELEVENTH_INDEX),
        };
      }

      if (wickPct < WICK_11_MIN_PERCENTAGE) {
        state.matchedLength = WICK_ELEVENTH_INDEX;
        return {
          kind: 'INVALIDATED',
          reason: 'WICK_BELOW_MINIMUM',
          window,
          wickPercentage11: wickPct,
          progress: this.buildProgress(activeId, state, WICK_ELEVENTH_INDEX),
        };
      }

      return {
        kind: 'CONFIRMED',
        window,
        wickPercentage11: wickPct,
        progress: this.buildProgress(activeId, state, PATTERN_LENGTH),
      };
    }

    return { kind: 'PROGRESS', progress: this.buildProgress(activeId, state, matchedLength) };
  }

  /**
   * Preview em tempo real do pavio da 11a vela ENQUANTO ela ainda esta se formando.
   * Retorna null quando o ativo nao esta logo antes da posicao do pavio (ou quando
   * WICK_RULE_APPLIES=false, ja que matchedLength nunca chega em WICK_ELEVENTH_INDEX se a
   * regra e mais curta que isso). Nunca confirma nem invalida nada — e apenas informativo.
   */
  previewEleventh(activeId: number, formingCandle: Candle): WickPreview | null {
    const state = this.states.get(activeId);
    if (!state || state.matchedLength !== WICK_ELEVENTH_INDEX) return null;
    const last = state.buffer[state.buffer.length - 1];
    if (!last || formingCandle.from !== last.to) return null; // nao e contiguo -> nem seria a 11a de verdade

    return {
      currentPercentage: lowerWickPercentage(formingCandle),
      requiredPercentage: WICK_11_MIN_PERCENTAGE,
    };
  }

  getProgress(activeId: number): PatternProgress {
    const state = this.getState(activeId);
    return this.buildProgress(activeId, state, state.matchedLength);
  }

  private buildProgress(activeId: number, state: ActiveState, matchedLength: number): PatternProgress {
    const received = colorsOf(state.buffer.slice(state.buffer.length - matchedLength));
    return {
      activeId,
      matchedLength,
      expected: [...TWELVE_CANDLES_PATTERN],
      received,
      state: patternDisplayState(matchedLength),
      lastUpdatedAt: Date.now(),
    };
  }
}
