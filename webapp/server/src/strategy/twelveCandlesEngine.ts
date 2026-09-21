import { candleColor, patternDisplayState, type Candle, type CandleColor, type PatternProgress } from '@polarium12c/shared';

/** wickPercentage11 nao e mais calculado (regra de pavio retirada) — sentinela mantido so por compatibilidade de schema/tipos. */
const WICK_NOT_APPLICABLE = 1;

/**
 * Motor do padrao customizado ativo.
 *
 * Algoritmo: mantem, por ativo, um buffer com os ultimos ate `pattern.length` candles M1
 * FECHADOS e CONSECUTIVOS (qualquer gap zera o buffer para conter so o candle novo). A cada
 * candle fechado, recalcula do zero o maior L tal que as ULTIMAS L cores do buffer sejam
 * iguais as PRIMEIRAS L posicoes do padrao. Isso implementa exatamente "procure o maior
 * prefixo do padrao que ainda corresponda ao final das velas recebidas" — e, por recalcular
 * do zero a cada tick sobre uma janela deslizante, suporta padroes sobrepostos sem nenhuma
 * logica extra de "continuar apos confirmar". Generaliza automaticamente para qualquer
 * padrao/tamanho definido pelo usuario na tela de edicao de padrao.
 */

export type TwelveCandlesTick =
  | { kind: 'PROGRESS'; progress: PatternProgress }
  | { kind: 'CONFIRMED'; progress: PatternProgress; window: Candle[]; wickPercentage11: number };

interface ActiveState {
  buffer: Candle[];
  matchedLength: number;
}

function colorsOf(candles: Candle[]): CandleColor[] {
  return candles.map((c) => candleColor(c));
}

export class TwelveCandlesEngine {
  private states = new Map<number, ActiveState>();

  /** `pattern` e o prefixo que precisa casar antes de confirmar (NAO inclui a vela de entrada). */
  constructor(private readonly pattern: readonly CandleColor[]) {
    if (pattern.length === 0) {
      throw new Error('TwelveCandlesEngine precisa de um padrao com pelo menos 1 vela de confirmacao.');
    }
  }

  private get patternLength(): number {
    return this.pattern.length;
  }

  private getState(activeId: number): ActiveState {
    let s = this.states.get(activeId);
    if (!s) {
      s = { buffer: [], matchedLength: 0 };
      this.states.set(activeId, s);
    }
    return s;
  }

  /** Maior L (0..min(buffer.length, patternLength)) tal que o final do buffer bate com o inicio do padrao. */
  private longestMatch(buffer: Candle[]): number {
    const colors = colorsOf(buffer);
    const maxL = Math.min(buffer.length, this.patternLength);
    for (let L = maxL; L > 0; L--) {
      const tail = colors.slice(colors.length - L);
      let matches = true;
      for (let i = 0; i < L; i++) {
        if (tail[i] !== this.pattern[i]) {
          matches = false;
          break;
        }
      }
      if (matches) return L;
    }
    return 0;
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

    const nextBuffer = contiguous ? [...state.buffer, candle] : [candle];
    const trimmed = nextBuffer.length > this.patternLength ? nextBuffer.slice(nextBuffer.length - this.patternLength) : nextBuffer;

    const matchedLength = this.longestMatch(trimmed);
    state.buffer = trimmed;
    state.matchedLength = matchedLength;

    if (matchedLength === this.patternLength) {
      const window = trimmed.slice(trimmed.length - this.patternLength);
      return {
        kind: 'CONFIRMED',
        window,
        wickPercentage11: WICK_NOT_APPLICABLE,
        progress: this.buildProgress(activeId, state, this.patternLength),
      };
    }

    return { kind: 'PROGRESS', progress: this.buildProgress(activeId, state, matchedLength) };
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
      expected: [...this.pattern],
      received,
      state: patternDisplayState(matchedLength, this.patternLength),
      lastUpdatedAt: Date.now(),
    };
  }
}
