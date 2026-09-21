import { describe, expect, it } from 'vitest';
import type { Candle } from '@polarium12c/shared';
import {
  DEFAULT_COMPRESSION_BREAKOUT_PARAMS,
  DEFAULT_ENGULFING_PARAMS,
  DEFAULT_IMPULSE_PULLBACK_PARAMS,
  DEFAULT_PIN_BAR_PARAMS,
  DEFAULT_SEQUENCE_REVERSAL_PARAMS,
} from '@polarium12c/shared';
import { MockBrokerAdapter } from '../src/broker/MockBrokerAdapter.js';
import { runClassicStrategy } from '../src/strategies/classicStrategies.js';

const ACTIVE = 81;
const SIZE = 60;
// Ancorado relativo a Date.now() (nunca um literal fixo) — runClassicStrategy busca historico
// com `to = now` real, entao um timestamp fixo no passado pode acabar no FUTURO relativo ao
// momento em que o teste roda. 6h atras fica sempre dentro da janela de 30 dias usada aqui.
const BASE = Math.floor(Date.now() / 1000) - 6 * 60 * 60;

/** Candle com OHLC explicito, sempre com `to = from + SIZE`. */
function candle(from: number, open: number, high: number, low: number, close: number): Candle {
  return { activeId: ACTIVE, size: SIZE, from, to: from + SIZE, open, high, low, close, isClosed: true };
}

/** Vela verde/vermelha "seca" (sem pavio), corpo = todo o range. */
function solid(from: number, color: 'G' | 'R', bodySize = 10): Candle {
  return color === 'G' ? candle(from, 0, bodySize, 0, bodySize) : candle(from, bodySize, bodySize, 0, 0);
}

async function run(candles: Candle[], strategy: Parameters<typeof runClassicStrategy>[3]) {
  const broker = new MockBrokerAdapter();
  await broker.authenticate();
  broker.seedCandles(ACTIVE, candles);
  return runClassicStrategy(broker, ACTIVE, 30, strategy);
}

describe('runClassicStrategy — sequence_reversal', () => {
  it('detecta reversao apos N velas da mesma cor e confirma CALL na vela seguinte', async () => {
    const params = { ...DEFAULT_SEQUENCE_REVERSAL_PARAMS, sequenceLength: 4 };
    let from = BASE;
    const candles: Candle[] = [];
    for (let i = 0; i < 4; i++) {
      candles.push(solid(from, 'R'));
      from += SIZE;
    }
    candles.push(solid(from, 'G')); // reversao: corpo cheio, sem pavio oposto
    from += SIZE;
    candles.push(solid(from, 'G')); // entrada: fecha em alta -> WIN para CALL

    const result = await run(candles, { id: 'sequence_reversal', params });
    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0]!.direction).toBe('CALL');
    expect(result.occurrences[0]!.result).toBe('WIN');
  });

  it('nao detecta quando a sequencia nao tem a mesma cor em todas as velas', async () => {
    const params = { ...DEFAULT_SEQUENCE_REVERSAL_PARAMS, sequenceLength: 4 };
    let from = BASE;
    const candles: Candle[] = [solid(from, 'R')];
    from += SIZE;
    candles.push(solid(from, 'G')); // quebra a sequencia
    from += SIZE;
    candles.push(solid(from, 'R'));
    from += SIZE;
    candles.push(solid(from, 'R'));
    from += SIZE;
    candles.push(solid(from, 'G'));
    from += SIZE;
    candles.push(solid(from, 'G'));

    const result = await run(candles, { id: 'sequence_reversal', params });
    expect(result.occurrences).toHaveLength(0);
  });

  it('respeita o filtro de direcao (CALL_ONLY ignora reversoes PUT)', async () => {
    const params = { ...DEFAULT_SEQUENCE_REVERSAL_PARAMS, sequenceLength: 2, direction: 'CALL_ONLY' as const };
    let from = BASE;
    const candles: Candle[] = [solid(from, 'G')];
    from += SIZE;
    candles.push(solid(from, 'G'));
    from += SIZE;
    candles.push(solid(from, 'R')); // reversao seria PUT — deve ser ignorada
    from += SIZE;
    candles.push(solid(from, 'R'));

    const result = await run(candles, { id: 'sequence_reversal', params });
    expect(result.occurrences).toHaveLength(0);
  });
});

describe('runClassicStrategy — engulfing', () => {
  it('detecta bullish engulfing (corpo atual engolfa o anterior) e confirma CALL', async () => {
    const params = { ...DEFAULT_ENGULFING_PARAMS, minBodyRatio: 1.2 };
    let from = BASE;
    const candles: Candle[] = [
      candle(from, 10, 10, 0, 5), // vermelha, corpo 5 (10->5)
    ];
    from += SIZE;
    candles.push(candle(from, 4, 12, 4, 12)); // verde, corpo 8, engolfa [5,10]
    from += SIZE;
    candles.push(solid(from, 'G')); // entrada: WIN para CALL

    const result = await run(candles, { id: 'engulfing', params });
    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0]!.direction).toBe('CALL');
  });

  it('nao detecta quando o corpo atual nao engolfa o anterior', async () => {
    const params = { ...DEFAULT_ENGULFING_PARAMS };
    let from = BASE;
    const candles: Candle[] = [candle(from, 10, 10, 5, 5)]; // vermelha corpo [5,10]
    from += SIZE;
    candles.push(candle(from, 6, 9, 6, 9)); // verde corpo [6,9] — nao engolfa
    from += SIZE;
    candles.push(solid(from, 'G'));

    const result = await run(candles, { id: 'engulfing', params });
    expect(result.occurrences).toHaveLength(0);
  });

  it('nao detecta quando o corpo atual nao atinge o ratio minimo', async () => {
    const params = { ...DEFAULT_ENGULFING_PARAMS, minBodyRatio: 3 };
    let from = BASE;
    const candles: Candle[] = [candle(from, 10, 10, 0, 8)]; // vermelha corpo 2 [8,10]
    from += SIZE;
    candles.push(candle(from, 7, 11, 7, 11)); // verde corpo 4 [7,11] — engolfa mas ratio so 2x
    from += SIZE;
    candles.push(solid(from, 'G'));

    const result = await run(candles, { id: 'engulfing', params });
    expect(result.occurrences).toHaveLength(0);
  });
});

describe('runClassicStrategy — pin_bar', () => {
  it('detecta pin bar bullish (pavio inferior grande, fechamento no topo) e confirma CALL', async () => {
    const params = { ...DEFAULT_PIN_BAR_PARAMS, minWickPercent: 0.6, maxBodyPercent: 0.3, minClosePositionPercent: 0.7 };
    let from = BASE;
    // range 0..100: pavio inferior de 70 (open/close entre 70 e 80), fecha em 80 (posicao 0.8)
    const candles: Candle[] = [candle(from, 70, 80, 0, 80)];
    from += SIZE;
    candles.push(solid(from, 'G'));

    const result = await run(candles, { id: 'pin_bar', params });
    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0]!.direction).toBe('CALL');
  });

  it('nao detecta quando o corpo e grande demais', async () => {
    const params = { ...DEFAULT_PIN_BAR_PARAMS, maxBodyPercent: 0.2 };
    let from = BASE;
    const candles: Candle[] = [candle(from, 40, 100, 0, 80)]; // corpo 40 de 100 = 40%
    from += SIZE;
    candles.push(solid(from, 'G'));

    const result = await run(candles, { id: 'pin_bar', params });
    expect(result.occurrences).toHaveLength(0);
  });
});

describe('runClassicStrategy — impulse_pullback', () => {
  it('detecta impulso grande seguido de pullback pequeno e confirma CALL', async () => {
    const params = { ...DEFAULT_IMPULSE_PULLBACK_PARAMS, medianLookback: 3, minImpulseRangeMultiplier: 1.5, maxPullbackRetracePercent: 0.5 };
    let from = BASE;
    const candles: Candle[] = [];
    for (let i = 0; i < 3; i++) {
      candles.push(solid(from, i % 2 === 0 ? 'G' : 'R', 4)); // range pequeno (4) para a mediana
      from += SIZE;
    }
    candles.push(solid(from, 'G', 20)); // impulso: range 20, bem acima da mediana 4
    from += SIZE;
    candles.push(candle(from, 20, 20, 12, 12)); // pullback vermelho pequeno, retrace de 8 (< 50% de 20)
    from += SIZE;
    candles.push(solid(from, 'G')); // entrada: WIN para CALL

    const result = await run(candles, { id: 'impulse_pullback', params });
    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0]!.direction).toBe('CALL');
  });

  it('nao detecta quando o pullback devolve demais do impulso', async () => {
    const params = { ...DEFAULT_IMPULSE_PULLBACK_PARAMS, medianLookback: 3, minImpulseRangeMultiplier: 1.5, maxPullbackRetracePercent: 0.3 };
    let from = BASE;
    const candles: Candle[] = [];
    for (let i = 0; i < 3; i++) {
      candles.push(solid(from, i % 2 === 0 ? 'G' : 'R', 4));
      from += SIZE;
    }
    candles.push(solid(from, 'G', 20));
    from += SIZE;
    candles.push(candle(from, 20, 20, 5, 5)); // pullback devolve 15 de 20 (75%) — bem acima do limite de 30%
    from += SIZE;
    candles.push(solid(from, 'G'));

    const result = await run(candles, { id: 'impulse_pullback', params });
    expect(result.occurrences).toHaveLength(0);
  });
});

describe('runClassicStrategy — compression_breakout', () => {
  it('detecta rompimento de alta apos bloco de compressao e confirma CALL', async () => {
    const params = { ...DEFAULT_COMPRESSION_BREAKOUT_PARAMS, compressionLength: 3, medianLookback: 5, maxCompressionRangeRatio: 1.0 };
    let from = BASE;
    const candles: Candle[] = [];
    // 5 velas de referencia com range medio 10 (para a mediana)
    for (let i = 0; i < 5; i++) {
      candles.push(solid(from, i % 2 === 0 ? 'G' : 'R', 10));
      from += SIZE;
    }
    // bloco de compressao: 3 velas com range bem menor (2) — dentro do bloco 100..102 etc.
    for (let i = 0; i < 3; i++) {
      candles.push(candle(from, 100, 102, 100, 101));
      from += SIZE;
    }
    // breakout: fecha acima da maxima do bloco (102)
    candles.push(candle(from, 101, 110, 101, 110));
    from += SIZE;
    candles.push(solid(from, 'G')); // entrada: WIN para CALL

    const result = await run(candles, { id: 'compression_breakout', params });
    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0]!.direction).toBe('CALL');
  });

  it('nao detecta quando o bloco nao esta comprimido (range acima da mediana)', async () => {
    const params = { ...DEFAULT_COMPRESSION_BREAKOUT_PARAMS, compressionLength: 3, medianLookback: 5, maxCompressionRangeRatio: 1.0 };
    let from = BASE;
    const candles: Candle[] = [];
    for (let i = 0; i < 5; i++) {
      candles.push(solid(from, i % 2 === 0 ? 'G' : 'R', 10));
      from += SIZE;
    }
    // bloco NAO comprimido: range 20, maior que a mediana de referencia (10)
    for (let i = 0; i < 3; i++) {
      candles.push(candle(from, 100, 120, 100, 110));
      from += SIZE;
    }
    candles.push(candle(from, 110, 130, 110, 130));
    from += SIZE;
    candles.push(solid(from, 'G'));

    const result = await run(candles, { id: 'compression_breakout', params });
    expect(result.occurrences).toHaveLength(0);
  });
});
