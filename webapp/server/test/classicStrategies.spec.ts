import { describe, expect, it, vi } from 'vitest';
import type { Candle } from '@polarium12c/shared';
import {
  DEFAULT_COMPRESSION_BREAKOUT_PARAMS,
  DEFAULT_ENGULFING_PARAMS,
  DEFAULT_IMPULSE_PULLBACK_PARAMS,
  DEFAULT_PIN_BAR_PARAMS,
  DEFAULT_SEQUENCE_REVERSAL_PARAMS,
} from '@polarium12c/shared';
import { MockBrokerAdapter } from '../src/broker/MockBrokerAdapter.js';
import { CLASSIC_STRATEGIES, defaultClassicStrategyConfig } from '@polarium12c/shared';
import { runClassicStrategy, runAllClassicStrategiesForAsset, detectPendingSignal } from '../src/strategies/classicStrategies.js';

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

/** Vela "achatada" — range minusculo so pra nao ser DOJI de verdade, usada nos testes de
 * Suporte/Resistencia como "historico estavel, sem nada acontecendo". */
function flat(from: number, price: number): Candle {
  return candle(from, price, price + 0.05, price - 0.05, price);
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

  it('Gale 1: WIN da 1a entrada passa direto, LOSS usa o resultado da reentrada (candle seguinte)', async () => {
    const params = { ...DEFAULT_SEQUENCE_REVERSAL_PARAMS, sequenceLength: 4 };
    let from = BASE;
    const candles: Candle[] = [];
    // Ocorrencia 1: sequencia R,R,R,R -> reversao G (CALL) -> entrada G -> WIN direto.
    for (let i = 0; i < 4; i++) {
      candles.push(solid(from, 'R'));
      from += SIZE;
    }
    candles.push(solid(from, 'G'));
    from += SIZE;
    candles.push(solid(from, 'G'));
    from += SIZE;
    // Ocorrencia 2: sequencia R,R,R,R -> reversao G (CALL) -> entrada R -> LOSS.
    for (let i = 0; i < 4; i++) {
      candles.push(solid(from, 'R'));
      from += SIZE;
    }
    candles.push(solid(from, 'G'));
    from += SIZE;
    candles.push(solid(from, 'R'));
    from += SIZE;
    candles.push(solid(from, 'G')); // reentrada controlada: fecha em alta

    const result = await run(candles, { id: 'sequence_reversal', params });
    expect(result.occurrences).toHaveLength(2);
    expect(result.occurrences[0]!.result).toBe('WIN');
    expect(result.occurrences[1]!.result).toBe('LOSS');

    expect(result.reentry.consideredLosses).toBe(1);
    expect(result.reentry.missingReentryCandle).toBe(0);
    // Combinado mesma direcao (CALL): WIN direto (occ1) + reentrada CALL da occ2 (fecha em alta -> WIN) = 2 wins.
    expect(result.reentry.combinedSameDirection).toEqual({ wins: 2, losses: 0, dojis: 0 });
    // Combinado direcao oposta (PUT): WIN direto (occ1) passa igual + reentrada PUT da occ2 (fecha em alta -> LOSS).
    expect(result.reentry.combinedOppositeDirection).toEqual({ wins: 1, losses: 1, dojis: 0 });
    // Isolado (SO a occ2, sem misturar o win direto da occ1).
    expect(result.reentry.reentryOnlySameDirection).toEqual({ wins: 1, losses: 0, dojis: 0 });
    expect(result.reentry.reentryOnlyOppositeDirection).toEqual({ wins: 0, losses: 1, dojis: 0 });
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

describe('runAllClassicStrategiesForAsset', () => {
  it('busca o historico UMA unica vez e devolve um resultado por estrategia', async () => {
    const broker = new MockBrokerAdapter();
    await broker.authenticate();
    const candles: Candle[] = [];
    let from = BASE;
    for (let i = 0; i < 10; i++) {
      candles.push(solid(from, i % 2 === 0 ? 'G' : 'R'));
      from += SIZE;
    }
    broker.seedCandles(ACTIVE, candles);
    const spy = vi.spyOn(broker, 'getHistoricalCandles');

    const configs = CLASSIC_STRATEGIES.map((s) => defaultClassicStrategyConfig(s.id));
    const results = await runAllClassicStrategiesForAsset(broker, ACTIVE, 30, configs);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(CLASSIC_STRATEGIES.length);
    expect(results.map((r) => r.strategy.id)).toEqual(CLASSIC_STRATEGIES.map((s) => s.id));
  });
});

describe('detectPendingSignal', () => {
  it('acusa sinal pendente quando o setup acabou de se completar na ultima vela FECHADA', () => {
    const params = { ...DEFAULT_SEQUENCE_REVERSAL_PARAMS, sequenceLength: 4 };
    let from = BASE;
    const candles: Candle[] = [];
    for (let i = 0; i < 4; i++) {
      candles.push(solid(from, 'R'));
      from += SIZE;
    }
    candles.push(solid(from, 'G')); // reversao acabou de fechar — SEM candle de entrada ainda
    const pending = detectPendingSignal(candles, { id: 'sequence_reversal', params });
    expect(pending).not.toBeNull();
    expect(pending!.direction).toBe('CALL');
  });

  it('nao acusa nada quando nenhum setup se completou na ultima vela', () => {
    const params = { ...DEFAULT_SEQUENCE_REVERSAL_PARAMS, sequenceLength: 4 };
    let from = BASE;
    const candles: Candle[] = [solid(from, 'R')];
    from += SIZE;
    candles.push(solid(from, 'G')); // so 1 vela — nao fecha sequencia nenhuma
    expect(detectPendingSignal(candles, { id: 'sequence_reversal', params })).toBeNull();
  });

  it('para de acusar depois que a entrada de verdade ja aconteceu (nao fica preso no passado)', async () => {
    const params = { ...DEFAULT_SEQUENCE_REVERSAL_PARAMS, sequenceLength: 4 };
    let from = BASE;
    const candles: Candle[] = [];
    for (let i = 0; i < 4; i++) {
      candles.push(solid(from, 'R'));
      from += SIZE;
    }
    candles.push(solid(from, 'G'));
    from += SIZE;
    candles.push(solid(from, 'G')); // entrada ja aconteceu — o setup "acabou" 1 vela atras, nao agora
    expect(detectPendingSignal(candles, { id: 'sequence_reversal', params })).toBeNull();
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

describe('runClassicStrategy — inside_bar_breakout', () => {
  it('detecta inside bar seguida de rompimento de alta e confirma CALL', async () => {
    let from = BASE;
    const candles: Candle[] = [candle(from, 20, 100, 0, 80)]; // vela-mae, range [0,100]
    from += SIZE;
    candles.push(candle(from, 40, 80, 20, 60)); // inside bar: dentro de [0,100]
    from += SIZE;
    candles.push(candle(from, 90, 120, 90, 110)); // rompimento: fecha acima de 100
    from += SIZE;
    candles.push(solid(from, 'G'));

    const result = await run(candles, { id: 'inside_bar_breakout' });
    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0]!.direction).toBe('CALL');
  });

  it('nao detecta quando o rompimento nao fecha alem do range da vela-mae', async () => {
    let from = BASE;
    const candles: Candle[] = [candle(from, 20, 100, 0, 80)];
    from += SIZE;
    candles.push(candle(from, 40, 80, 20, 60)); // inside bar
    from += SIZE;
    candles.push(candle(from, 60, 95, 55, 90)); // fecha dentro do range da mae (90 < 100)
    from += SIZE;
    candles.push(solid(from, 'G'));

    const result = await run(candles, { id: 'inside_bar_breakout' });
    expect(result.occurrences).toHaveLength(0);
  });
});

describe('runClassicStrategy — fakeout', () => {
  it('detecta fakeout de baixa (rompe minima e fecha de volta acima) e confirma CALL', async () => {
    let from = BASE;
    const candles: Candle[] = [];
    for (let i = 0; i < 5; i++) {
      candles.push(candle(from, 60, 70, 50, 65)); // lookback: low sempre 50
      from += SIZE;
    }
    candles.push(candle(from, 59, 61, 40, 60)); // rompe 50 (low=40) mas fecha em 60 (> 50), pavio forte
    from += SIZE;
    candles.push(solid(from, 'G'));

    const result = await run(candles, { id: 'fakeout' });
    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0]!.direction).toBe('CALL');
  });

  it('nao detecta quando o pavio de rejeicao e pequeno demais', async () => {
    let from = BASE;
    const candles: Candle[] = [];
    for (let i = 0; i < 5; i++) {
      candles.push(candle(from, 60, 70, 50, 65));
      from += SIZE;
    }
    candles.push(candle(from, 41, 61, 40, 60)); // rompe e fecha de volta, mas pavio inferior so 1/21 ~ 5%
    from += SIZE;
    candles.push(solid(from, 'G'));

    const result = await run(candles, { id: 'fakeout' });
    expect(result.occurrences).toHaveLength(0);
  });
});

describe('runClassicStrategy — three_soldiers', () => {
  it('detecta 3 velas verdes com corpos fortes e progressao e confirma CALL na 4a', async () => {
    let from = BASE;
    const candles: Candle[] = [
      candle(from, 10, 102, 10, 100), // corpo 90/92 ~ 0.98, pavio superior 2/92 ~ 0.02
    ];
    from += SIZE;
    candles.push(candle(from, 100, 152, 100, 150)); // fecha mais alto que a anterior
    from += SIZE;
    candles.push(candle(from, 150, 202, 150, 200)); // fecha mais alto ainda
    from += SIZE;
    candles.push(solid(from, 'G'));

    const result = await run(candles, { id: 'three_soldiers' });
    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0]!.direction).toBe('CALL');
  });

  it('nao detecta quando uma das velas tem corpo fraco', async () => {
    let from = BASE;
    const candles: Candle[] = [candle(from, 10, 102, 10, 100)];
    from += SIZE;
    candles.push(candle(from, 100, 160, 100, 110)); // corpo pequeno (10/60 ~ 0.17)
    from += SIZE;
    candles.push(candle(from, 110, 210, 110, 200));
    from += SIZE;
    candles.push(solid(from, 'G'));

    const result = await run(candles, { id: 'three_soldiers' });
    expect(result.occurrences).toHaveLength(0);
  });
});

describe('runClassicStrategy — impulse_pullback_50', () => {
  it('detecta impulso + pullback de 30-50% contido no impulso e confirma CALL', async () => {
    const params_medianLookback = 10;
    let from = BASE;
    const candles: Candle[] = [];
    for (let i = 0; i < params_medianLookback; i++) {
      candles.push(solid(from, i % 2 === 0 ? 'G' : 'R', 4)); // range pequeno para a mediana
      from += SIZE;
    }
    candles.push(solid(from, 'G', 20)); // impulso: range 20
    from += SIZE;
    candles.push(candle(from, 20, 20, 12, 12)); // pullback: contido em [0,20], corpo 8 (40% de 20)
    from += SIZE;
    candles.push(solid(from, 'G')); // entrada: WIN para CALL

    const result = await run(candles, { id: 'impulse_pullback_50' });
    expect(result.occurrences).toHaveLength(1);
    expect(result.occurrences[0]!.direction).toBe('CALL');
  });

  it('nao detecta quando o pullback devolve mais que 50% do impulso', async () => {
    let from = BASE;
    const candles: Candle[] = [];
    for (let i = 0; i < 10; i++) {
      candles.push(solid(from, i % 2 === 0 ? 'G' : 'R', 4));
      from += SIZE;
    }
    candles.push(solid(from, 'G', 20));
    from += SIZE;
    candles.push(candle(from, 20, 20, 5, 5)); // retrace de 15/20 = 75%
    from += SIZE;
    candles.push(solid(from, 'G'));

    const result = await run(candles, { id: 'impulse_pullback_50' });
    expect(result.occurrences).toHaveLength(0);
  });
});

describe('runClassicStrategy — double_rejection', () => {
  /** Vela "neutra" de preenchimento: range 10, pavio inferior fraco (nao deve casar como rejeicao). */
  function filler(from: number): Candle {
    return candle(from, 7, 10, 0, 3);
  }

  it('detecta duas rejeicoes de minima proximas e confirma CALL', async () => {
    let from = BASE;
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push(filler(from));
      from += SIZE;
    }
    candles.push(candle(from, 8, 10, 0, 9)); // 1a rejeicao: low=0, pavio inferior forte
    from += SIZE;
    candles.push(filler(from));
    from += SIZE;
    candles.push(filler(from));
    from += SIZE;
    candles.push(candle(from, 9, 10, 1, 9.5)); // 2a rejeicao: low=1 (perto de 0), pavio forte, nao rompe abaixo
    from += SIZE;
    candles.push(solid(from, 'G')); // entrada

    const result = await run(candles, { id: 'double_rejection' });
    expect(result.occurrences.length).toBeGreaterThanOrEqual(1);
    expect(result.occurrences[0]!.direction).toBe('CALL');
  });

  it('nao detecta quando a segunda rejeicao rompe bem abaixo da primeira', async () => {
    let from = BASE;
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push(filler(from));
      from += SIZE;
    }
    candles.push(candle(from, 8, 10, 0, 9)); // 1a rejeicao: low=0
    from += SIZE;
    candles.push(filler(from));
    from += SIZE;
    candles.push(filler(from));
    from += SIZE;
    candles.push(candle(from, 9, 10, -20, 9.5)); // 2a "rejeicao": low bem abaixo da 1a (rompeu de verdade)
    from += SIZE;
    candles.push(solid(from, 'G'));

    const result = await run(candles, { id: 'double_rejection' });
    expect(result.occurrences).toHaveLength(0);
  });
});

// ---- Suporte e Resistencia (baseada em indicador: zigzag + CCI + Bandas de Bollinger) ----

/**
 * Monta uma sequencia de candles com um SUPORTE (nivel 90) validado por DOIS toques via
 * zigzag, uma janela calma depois (pra Bollinger/CCI ficarem "normais"), e uma vela final que
 * testa o nivel de novo com rejeicao forte, CCI esticado e fechamento alem da banda — as 3
 * confirmacoes que detectSupportResistance exige. Cada numero foi conferido rodando os
 * indicadores de verdade (zigzagPivots/cci/bollingerBands) sobre esta mesma sequencia.
 */
function buildSupportTouchCandles(): Candle[] {
  let from = BASE;
  const candles: Candle[] = [];
  const push = (open: number, high: number, low: number, close: number) => {
    candles.push(candle(from, open, high, low, close));
    from += SIZE;
  };

  for (let i = 0; i < 10; i++) push(100, 100.3, 99.7, 100 + (i % 2 === 0 ? 0.1 : -0.1)); // filler estavel
  push(100, 100, 90, 91); // 1o toque: cai pra 90 (-10%), trend vira 'down'
  push(91, 96, 91, 95); // confirma o fundo em 90 (+6.7% bate o limiar de 5%)
  for (let i = 0; i < 8; i++) push(94, 95.5, 93, 94.5); // janela intermediaria, sempre abaixo do extremo (96)
  push(94, 95.5, 90, 91); // 2o toque: rompe o piso (90 <= 96*0.95), confirma topo intermediario
  push(91, 96, 91, 95); // confirma o 2o fundo em 90 — nivel agora validado (2 toques)
  for (let i = 0; i < 20; i++) push(101.8 + (i % 2) * 0.4, 102.3, 101.5, 101.8 + (i % 2) * 0.4); // janela calma
  push(92, 93, 90, 92.8); // SINAL: testa o nivel 90 de novo, rejeicao forte, CCI/Bollinger esticados
  push(93, 98, 93, 97); // ENTRADA: fecha em alta -> WIN para CALL

  return candles;
}

/** Espelho estrutural (nao por negacao de preco — isso quebraria os limiares percentuais) do
 * cenario acima pro lado RESISTENCIA/PUT: nivel 110 tocado 2x, janela calma abaixo dele, vela
 * de sinal rompe pra cima com rejeicao (fecha perto do fundo do proprio range). */
function buildResistanceTouchCandles(): Candle[] {
  let from = BASE;
  const candles: Candle[] = [];
  const push = (open: number, high: number, low: number, close: number) => {
    candles.push(candle(from, open, high, low, close));
    from += SIZE;
  };

  for (let i = 0; i < 10; i++) push(100, 100.3, 99.7, 100 + (i % 2 === 0 ? 0.1 : -0.1)); // filler estavel
  push(100, 110, 100, 108); // 1o toque: sobe pra 110 (+10%), trend vira 'up'
  push(108, 108, 103, 104); // confirma o topo em 110 (-6.4% bate o limiar de 5%)
  for (let i = 0; i < 8; i++) push(105, 106, 104, 105); // janela intermediaria, sempre acima do extremo (103)
  push(105, 110, 104, 109); // 2o toque: rompe o teto (110 >= 103*1.05), confirma fundo intermediario
  push(109, 108, 104, 105); // confirma o 2o topo em 110 — nivel agora validado (2 toques)
  for (let i = 0; i < 20; i++) push(97.8 + (i % 2) * 0.4, 98.3, 97.5, 97.8 + (i % 2) * 0.4); // janela calma
  push(108, 110, 107, 107.2); // SINAL: testa o nivel 110 de novo, rejeicao forte, CCI/Bollinger esticados
  push(107, 108, 100, 101); // ENTRADA: fecha em baixa -> WIN para PUT

  return candles;
}

describe('runClassicStrategy — support_resistance', () => {
  it('detecta toque validado em suporte (2 toques via zigzag) com CCI/Bollinger confirmando e sinaliza CALL', async () => {
    const result = await run(buildSupportTouchCandles(), defaultClassicStrategyConfig('support_resistance'));
    expect(result.occurrences.length).toBeGreaterThanOrEqual(1);
    const occ = result.occurrences[result.occurrences.length - 1]!;
    expect(occ.direction).toBe('CALL');
    expect(occ.result).toBe('WIN');
    expect(occ.signalMetricValue).toBeGreaterThanOrEqual(2); // numero de toques no nivel
  });

  it('detecta toque validado em resistencia e sinaliza PUT', async () => {
    const result = await run(buildResistanceTouchCandles(), defaultClassicStrategyConfig('support_resistance'));
    expect(result.occurrences.length).toBeGreaterThanOrEqual(1);
    const occ = result.occurrences[result.occurrences.length - 1]!;
    expect(occ.direction).toBe('PUT');
    expect(occ.result).toBe('WIN');
  });

  it('nao detecta nada num historico estavel, sem nenhum nivel validado nem CCI/Bollinger esticados', async () => {
    let from = BASE;
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      candles.push(flat(from, 100 + (i % 3) * 0.1));
      from += SIZE;
    }
    const result = await run(candles, defaultClassicStrategyConfig('support_resistance'));
    expect(result.occurrences).toHaveLength(0);
  });

  it('nao detecta quando so houve UM toque no nivel (nao validado)', async () => {
    // Mesma construcao, mas sem o 2o toque — so 1 pivo no nivel 90, abaixo de SR_MIN_TOUCHES.
    let from = BASE;
    const candles: Candle[] = [];
    const push = (open: number, high: number, low: number, close: number) => {
      candles.push(candle(from, open, high, low, close));
      from += SIZE;
    };
    for (let i = 0; i < 10; i++) push(100, 100.3, 99.7, 100 + (i % 2 === 0 ? 0.1 : -0.1));
    push(100, 100, 90, 91); // unico toque em 90
    push(91, 96, 91, 95);
    for (let i = 0; i < 28; i++) push(101.8 + (i % 2) * 0.4, 102.3, 101.5, 101.8 + (i % 2) * 0.4);
    push(92, 93, 90, 92.8); // testaria o nivel de novo, mas ele nunca foi validado (so 1 toque antes)
    push(93, 98, 93, 97);

    const result = await run(candles, defaultClassicStrategyConfig('support_resistance'));
    expect(result.occurrences).toHaveLength(0);
  });
});

describe('detectPendingSignal — support_resistance', () => {
  it('acusa sinal pendente quando o setup acabou de se completar na ultima vela FECHADA', () => {
    const all = buildSupportTouchCandles();
    const withoutEntry = all.slice(0, -1); // tira a vela de entrada — o setup "acabou de completar" agora
    const strategy = defaultClassicStrategyConfig('support_resistance');
    const pending = detectPendingSignal(withoutEntry, strategy);
    expect(pending).not.toBeNull();
    expect(pending!.direction).toBe('CALL');
  });

  it('nao acusa nada num historico estavel', () => {
    let from = BASE;
    const candles: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      candles.push(flat(from, 100 + (i % 3) * 0.1));
      from += SIZE;
    }
    const strategy = defaultClassicStrategyConfig('support_resistance');
    expect(detectPendingSignal(candles, strategy)).toBeNull();
  });

  it('para de acusar depois que a entrada de verdade ja aconteceu (nao fica preso no passado)', () => {
    const all = buildSupportTouchCandles(); // ja inclui a vela de entrada
    const strategy = defaultClassicStrategyConfig('support_resistance');
    expect(detectPendingSignal(all, strategy)).toBeNull();
  });
});
