import {
  candleColor,
  lowerWickPercentage,
  patternDisplayState,
  SIGNAL_WICK_MIN_LOWER_PERCENTAGE,
  type Candle,
  type CandleColor,
  type PatternProgress,
} from '@polarium12c/shared';

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
 *
 * Regra final (ver SIGNAL_WICK_MIN_LOWER_PERCENTAGE em strategyRule.ts): so quando o prefixo
 * inteiro casa, verifica se a VELA DE SINAL (a ultima do prefixo, a que acabou de fechar)
 * tem pavio inferior >= 25% do seu range. Se nao tiver, a ocorrencia e INVALIDATED — nao
 * confirma, nao gera sinal/ordem, nao entra em nenhuma analise.
 */

export type TwelveCandlesTick =
  | { kind: 'PROGRESS'; progress: PatternProgress }
  | { kind: 'CONFIRMED'; progress: PatternProgress; window: Candle[]; wickPercentage11: number }
  | {
      kind: 'INVALIDATED';
      progress: PatternProgress;
      window: Candle[];
      reason: 'WICK_BELOW_MINIMUM' | 'ZERO_RANGE';
      wickPercentage11: number | null;
    };

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
      const signalCandle = window[window.length - 1]!;
      const wickPct = lowerWickPercentage(signalCandle);

      if (wickPct === null) {
        // Candle degenerado (high === low) — nao da pra medir pavio, reprova a regra.
        // Reverte a exibicao para um passo antes, ja que essa janela nao confirma.
        state.matchedLength = this.patternLength - 1;
        return {
          kind: 'INVALIDATED',
          window,
          reason: 'ZERO_RANGE',
          wickPercentage11: null,
          progress: this.buildProgress(activeId, state, this.patternLength - 1),
        };
      }

      if (wickPct < SIGNAL_WICK_MIN_LOWER_PERCENTAGE) {
        state.matchedLength = this.patternLength - 1;
        return {
          kind: 'INVALIDATED',
          window,
          reason: 'WICK_BELOW_MINIMUM',
          wickPercentage11: wickPct,
          progress: this.buildProgress(activeId, state, this.patternLength - 1),
        };
      }

      return {
        kind: 'CONFIRMED',
        window,
        wickPercentage11: wickPct,
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
