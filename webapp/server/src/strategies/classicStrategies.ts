import { randomUUID } from 'node:crypto';
import {
  CANDLE_SIZE_M1,
  bodyPercentage,
  candleColor,
  bollingerBands,
  cci,
  lowerWickPercentage,
  upperWickPercentage,
  zigzagPivots,
  type Candle,
  type ClassicOccurrence,
  type ClassicStrategyConfig,
  type ClassicStrategyResult,
  type Direction,
  type TradeResult,
} from '@polarium12c/shared';
import type { BrokerAdapter } from '../broker/BrokerAdapter.js';
import { computeResultForDirection, oppositeDirection } from '../util/tradeResult.js';

/**
 * Motores de deteccao das 11 familias de estrategias classicas (ver shared/src/classicStrategies.ts
 * para os parametros de cada uma). Cada detector varre um array de candles FECHADOS e
 * ordenados e devolve, para cada ocorrencia achada, o indice da vela de ENTRADA (a vela
 * seguinte ao setup, cujo resultado sera avaliado) e a janela de velas que formou o setup.
 * Nenhum detector confirma nada nem envia ordem — e leitura de historico + calculo local,
 * igual ao backtestRunner do padrao customizado.
 */

interface RawSignal {
  entryIndex: number;
  direction: Direction;
  setupWindow: Candle[];
  /** Percentual (ou razao expressa como percentual) que mede a "forca" da vela de sinal desta ocorrencia. */
  signalMetricValue: number;
}

/** Rotulo do metric de forca do sinal, um por estrategia (constante ao longo de toda a execucao). */
const SIGNAL_METRIC_LABEL: Record<ClassicStrategyConfig['id'], string> = {
  sequence_reversal: 'Corpo da vela de reversão',
  engulfing: 'Corpo atual vs. anterior',
  pin_bar: 'Pavio da vela de sinal',
  impulse_pullback: 'Retração do pullback',
  compression_breakout: 'Corpo do rompimento',
  inside_bar_breakout: 'Corpo do rompimento',
  fakeout: 'Pavio de rejeição',
  three_soldiers: 'Corpo médio das 3 velas',
  impulse_pullback_50: 'Retração do pullback',
  double_rejection: 'Pavio de rejeição (mais fraco dos dois)',
  support_resistance: 'Toques anteriores no nível',
};

function bodySize(c: Candle): number {
  return Math.abs(c.close - c.open);
}

function candleRange(c: Candle): number {
  return c.high - c.low;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function passesDirectionFilter(direction: Direction, filter: 'BOTH' | 'CALL_ONLY' | 'PUT_ONLY'): boolean {
  if (filter === 'CALL_ONLY') return direction === 'CALL';
  if (filter === 'PUT_ONLY') return direction === 'PUT';
  return true;
}

/** N velas da mesma cor, seguidas de uma vela de reversao com corpo/pavio dentro dos limites — entra na proxima. */
function detectSequenceReversal(candles: Candle[], p: Extract<ClassicStrategyConfig, { id: 'sequence_reversal' }>['params']): RawSignal[] {
  const out: RawSignal[] = [];
  const N = p.sequenceLength;
  for (let i = N; i < candles.length - 1; i++) {
    const seq = candles.slice(i - N, i);
    const reversal = candles[i]!;
    const seqColor = candleColor(seq[0]!);
    if (seqColor === 'DOJI' || !seq.every((c) => candleColor(c) === seqColor)) continue;

    const revColor = candleColor(reversal);
    if (revColor === 'DOJI' || revColor === seqColor) continue;

    const direction: Direction = revColor === 'G' ? 'CALL' : 'PUT';
    if (!passesDirectionFilter(direction, p.direction)) continue;

    const body = bodyPercentage(reversal);
    if (body === null || body < p.minReversalBodyPercent) continue;

    // Pavio do lado OPOSTO a entrada: para CALL, o superior (rejeicao no topo enfraquece o sinal); para PUT, o inferior.
    const oppositeWick = direction === 'CALL' ? upperWickPercentage(reversal) : lowerWickPercentage(reversal);
    if (oppositeWick === null || oppositeWick > p.maxReversalOppositeWickPercent) continue;

    out.push({ entryIndex: i + 1, direction, setupWindow: [...seq, reversal], signalMetricValue: body });
  }
  return out;
}

/** Corpo atual engolfa o corpo anterior, cores opostas, corpo atual >= ratio x anterior — entra na proxima. */
function detectEngulfing(candles: Candle[], p: Extract<ClassicStrategyConfig, { id: 'engulfing' }>['params']): RawSignal[] {
  const out: RawSignal[] = [];
  for (let i = 1; i < candles.length - 1; i++) {
    const prev = candles[i - 1]!;
    const curr = candles[i]!;
    const prevColor = candleColor(prev);
    const currColor = candleColor(curr);
    if (prevColor === 'DOJI' || currColor === 'DOJI' || prevColor === currColor) continue;

    const direction: Direction = currColor === 'G' ? 'CALL' : 'PUT';
    if (!passesDirectionFilter(direction, p.direction)) continue;

    const prevBodyHigh = Math.max(prev.open, prev.close);
    const prevBodyLow = Math.min(prev.open, prev.close);
    const currBodyHigh = Math.max(curr.open, curr.close);
    const currBodyLow = Math.min(curr.open, curr.close);
    if (!(currBodyHigh >= prevBodyHigh && currBodyLow <= prevBodyLow)) continue;

    const prevBody = bodySize(prev);
    const currBody = bodySize(curr);
    if (prevBody === 0) continue;
    const ratio = currBody / prevBody;
    if (ratio < p.minBodyRatio) continue;

    const oppositeWick = direction === 'CALL' ? upperWickPercentage(curr) : lowerWickPercentage(curr);
    if (oppositeWick === null || oppositeWick > p.maxOppositeWickPercent) continue;

    out.push({ entryIndex: i + 1, direction, setupWindow: [prev, curr], signalMetricValue: ratio });
  }
  return out;
}

/** Corpo pequeno + pavio grande de um lado + fechamento perto do extremo oposto ao pavio — entra na proxima. */
function detectPinBar(candles: Candle[], p: Extract<ClassicStrategyConfig, { id: 'pin_bar' }>['params']): RawSignal[] {
  const out: RawSignal[] = [];
  for (let i = 0; i < candles.length - 1; i++) {
    const c = candles[i]!;
    const range = candleRange(c);
    if (range === 0) continue;

    const body = bodyPercentage(c);
    if (body === null || body > p.maxBodyPercent) continue;

    const lower = lowerWickPercentage(c)!;
    const upper = upperWickPercentage(c)!;
    const closePosition = (c.close - c.low) / range; // 0 = fechou na minima, 1 = fechou na maxima

    let direction: Direction | null = null;
    let wick = 0;
    if (lower >= p.minWickPercent && closePosition >= p.minClosePositionPercent) {
      direction = 'CALL';
      wick = lower;
    } else if (upper >= p.minWickPercent && 1 - closePosition >= p.minClosePositionPercent) {
      direction = 'PUT';
      wick = upper;
    }
    if (!direction || !passesDirectionFilter(direction, p.direction)) continue;

    out.push({ entryIndex: i + 1, direction, setupWindow: [c], signalMetricValue: wick });
  }
  return out;
}

/** Vela de impulso com range bem acima da mediana recente, seguida de correcao pequena — entra na proxima. */
function detectImpulsePullback(candles: Candle[], p: Extract<ClassicStrategyConfig, { id: 'impulse_pullback' }>['params']): RawSignal[] {
  const out: RawSignal[] = [];
  for (let i = p.medianLookback; i < candles.length - 2; i++) {
    const lookback = candles.slice(i - p.medianLookback, i);
    const medianRange = median(lookback.map(candleRange));
    if (medianRange === 0) continue;

    const impulse = candles[i]!;
    const impulseColor = candleColor(impulse);
    if (impulseColor === 'DOJI' || candleRange(impulse) < medianRange * p.minImpulseRangeMultiplier) continue;

    const pullback = candles[i + 1]!;
    const pullbackColor = candleColor(pullback);
    if (pullbackColor === 'DOJI' || pullbackColor === impulseColor) continue;

    const impulseBody = bodySize(impulse);
    if (impulseBody === 0) continue;
    const retrace = bodySize(pullback) / impulseBody;
    if (retrace > p.maxPullbackRetracePercent) continue;

    const direction: Direction = impulseColor === 'G' ? 'CALL' : 'PUT';
    if (!passesDirectionFilter(direction, p.direction)) continue;

    out.push({ entryIndex: i + 2, direction, setupWindow: [impulse, pullback], signalMetricValue: retrace });
  }
  return out;
}

/** Bloco de velas com range abaixo da mediana recente, seguido de rompimento do range do bloco — entra na proxima. */
function detectCompressionBreakout(
  candles: Candle[],
  p: Extract<ClassicStrategyConfig, { id: 'compression_breakout' }>['params']
): RawSignal[] {
  const out: RawSignal[] = [];
  const L = p.compressionLength;
  for (let i = p.medianLookback; i < candles.length - L - 1; i++) {
    const lookback = candles.slice(i - p.medianLookback, i);
    const medianRange = median(lookback.map(candleRange));
    if (medianRange === 0) continue;

    const block = candles.slice(i, i + L);
    if (!block.every((c) => candleRange(c) <= medianRange * p.maxCompressionRangeRatio)) continue;

    const blockHigh = Math.max(...block.map((c) => c.high));
    const blockLow = Math.min(...block.map((c) => c.low));

    const breakout = candles[i + L]!;
    const breakoutColor = candleColor(breakout);
    if (breakoutColor === 'DOJI') continue;

    let direction: Direction | null = null;
    if (breakoutColor === 'G' && breakout.close > blockHigh) direction = 'CALL';
    else if (breakoutColor === 'R' && breakout.close < blockLow) direction = 'PUT';
    if (!direction || !passesDirectionFilter(direction, p.direction)) continue;

    const breakoutBody = bodyPercentage(breakout) ?? 0;
    out.push({ entryIndex: i + L + 1, direction, setupWindow: [...block, breakout], signalMetricValue: breakoutBody });
  }
  return out;
}

// ---- As 5 estrategias abaixo nao tem params (regra fixa/classica, sem ajuste do usuario) ----

const FAKEOUT_LOOKBACK = 5;
const FAKEOUT_MIN_WICK_PERCENT = 0.5;

/**
 * Uma ou mais velas consecutivas dentro do range da vela-mae (inside bars), seguidas de
 * rompimento fechando alem do range da mae — entra na proxima. `i` so inicia uma busca nova
 * quando NAO for ele mesmo um inside bar do candle anterior, para nao contar a mesma
 * compressao varias vezes (uma por posicao interna a ela).
 */
function detectInsideBarBreakout(candles: Candle[]): RawSignal[] {
  const out: RawSignal[] = [];
  for (let i = 0; i < candles.length - 1; i++) {
    const mother = candles[i]!;
    const prev = i > 0 ? candles[i - 1] : undefined;
    // "mother" ja e parte de uma compressao anterior — so se aplica quando ha um candle antes pra comparar.
    if (prev && mother.high < prev.high && mother.low > prev.low) continue;

    let j = i + 1;
    while (j < candles.length && candles[j]!.high < mother.high && candles[j]!.low > mother.low) j++;
    if (j === i + 1) continue; // precisa de pelo menos 1 inside bar
    if (j >= candles.length) continue; // sem candle de rompimento disponivel ainda

    const breakout = candles[j]!;
    const breakoutColor = candleColor(breakout);
    if (breakoutColor === 'DOJI') continue;

    let direction: Direction | null = null;
    if (breakoutColor === 'G' && breakout.close > mother.high) direction = 'CALL';
    else if (breakoutColor === 'R' && breakout.close < mother.low) direction = 'PUT';
    if (!direction) continue;

    const breakoutBody = bodyPercentage(breakout) ?? 0;
    out.push({ entryIndex: j + 1, direction, setupWindow: candles.slice(i, j + 1), signalMetricValue: breakoutBody });
  }
  return out;
}

/**
 * Rompe a maxima/minima das ultimas FAKEOUT_LOOKBACK velas mas fecha de volta DENTRO do
 * range, com pavio de rejeicao forte do lado que rompeu — entra na proxima.
 */
function detectFakeout(candles: Candle[]): RawSignal[] {
  const out: RawSignal[] = [];
  for (let i = FAKEOUT_LOOKBACK; i < candles.length - 1; i++) {
    const lookback = candles.slice(i - FAKEOUT_LOOKBACK, i);
    const lookbackLow = Math.min(...lookback.map((c) => c.low));
    const lookbackHigh = Math.max(...lookback.map((c) => c.high));
    const c = candles[i]!;

    let direction: Direction | null = null;
    let wick = 0;
    if (c.low < lookbackLow && c.close > lookbackLow) {
      const lower = lowerWickPercentage(c);
      if (lower !== null && lower >= FAKEOUT_MIN_WICK_PERCENT) {
        direction = 'CALL';
        wick = lower;
      }
    } else if (c.high > lookbackHigh && c.close < lookbackHigh) {
      const upper = upperWickPercentage(c);
      if (upper !== null && upper >= FAKEOUT_MIN_WICK_PERCENT) {
        direction = 'PUT';
        wick = upper;
      }
    }
    if (!direction) continue;

    out.push({ entryIndex: i + 1, direction, setupWindow: [...lookback, c], signalMetricValue: wick });
  }
  return out;
}

const THREE_SOLDIERS_MIN_BODY_PERCENT = 0.6;
const THREE_SOLDIERS_MAX_OPPOSITE_WICK_PERCENT = 0.25;

/**
 * 3 velas da mesma cor, cada uma com corpo >= 60% do proprio range, fechamentos em progressao
 * (cada uma alem da anterior) e pavio do lado oposto a direcao pequeno — testa continuacao na
 * 4a vela.
 */
function detectThreeSoldiers(candles: Candle[]): RawSignal[] {
  const out: RawSignal[] = [];
  for (let i = 2; i < candles.length - 1; i++) {
    const three = [candles[i - 2]!, candles[i - 1]!, candles[i]!];
    const colors = three.map((c) => candleColor(c));
    if (colors[0] === 'DOJI' || !colors.every((c) => c === colors[0])) continue;

    const direction: Direction = colors[0] === 'G' ? 'CALL' : 'PUT';
    const progressing =
      direction === 'CALL'
        ? three[1]!.close > three[0]!.close && three[2]!.close > three[1]!.close
        : three[1]!.close < three[0]!.close && three[2]!.close < three[1]!.close;
    if (!progressing) continue;

    let strongBodies = true;
    let bodySum = 0;
    for (const c of three) {
      const body = bodyPercentage(c);
      const oppositeWick = direction === 'CALL' ? upperWickPercentage(c) : lowerWickPercentage(c);
      if (body === null || body < THREE_SOLDIERS_MIN_BODY_PERCENT) strongBodies = false;
      if (oppositeWick === null || oppositeWick > THREE_SOLDIERS_MAX_OPPOSITE_WICK_PERCENT) strongBodies = false;
      bodySum += body ?? 0;
    }
    if (!strongBodies) continue;

    out.push({ entryIndex: i + 1, direction, setupWindow: three, signalMetricValue: bodySum / three.length });
  }
  return out;
}

const IMPULSE_PULLBACK_50_MEDIAN_LOOKBACK = 10;
const IMPULSE_PULLBACK_50_MIN_IMPULSE_MULTIPLIER = 1.5;
const IMPULSE_PULLBACK_50_MIN_RETRACE = 0.3;
const IMPULSE_PULLBACK_50_MAX_RETRACE = 0.5;

/**
 * Igual a impulse_pullback, mas com banda de retracao fixa em 30-50% (nao so um teto) e
 * exigindo que o pullback fique CONTIDO dentro do range do candle de impulso.
 */
function detectImpulsePullback50(candles: Candle[]): RawSignal[] {
  const out: RawSignal[] = [];
  for (let i = IMPULSE_PULLBACK_50_MEDIAN_LOOKBACK; i < candles.length - 2; i++) {
    const lookback = candles.slice(i - IMPULSE_PULLBACK_50_MEDIAN_LOOKBACK, i);
    const medianRange = median(lookback.map(candleRange));
    if (medianRange === 0) continue;

    const impulse = candles[i]!;
    const impulseColor = candleColor(impulse);
    if (impulseColor === 'DOJI' || candleRange(impulse) < medianRange * IMPULSE_PULLBACK_50_MIN_IMPULSE_MULTIPLIER) continue;

    const pullback = candles[i + 1]!;
    const pullbackColor = candleColor(pullback);
    if (pullbackColor === 'DOJI' || pullbackColor === impulseColor) continue;
    if (pullback.high > impulse.high || pullback.low < impulse.low) continue; // precisa ficar contido no impulso

    const impulseBody = bodySize(impulse);
    if (impulseBody === 0) continue;
    const retrace = bodySize(pullback) / impulseBody;
    if (retrace < IMPULSE_PULLBACK_50_MIN_RETRACE || retrace > IMPULSE_PULLBACK_50_MAX_RETRACE) continue;

    const direction: Direction = impulseColor === 'G' ? 'CALL' : 'PUT';
    out.push({ entryIndex: i + 2, direction, setupWindow: [impulse, pullback], signalMetricValue: retrace });
  }
  return out;
}

const DOUBLE_REJECTION_MEDIAN_LOOKBACK = 20;
const DOUBLE_REJECTION_SEARCH_WINDOW = 20;
const DOUBLE_REJECTION_MIN_GAP = 2;
const DOUBLE_REJECTION_MIN_WICK_PERCENT = 0.5;
const DOUBLE_REJECTION_LEVEL_TOLERANCE_RATIO = 0.5; // fracao da mediana do range recente

/**
 * Duas velas com rejeicao forte (pavio grande) testando praticamente o mesmo nivel (minima
 * para CALL, maxima para PUT), a segunda sem romper significativamente alem da primeira —
 * entra na vela seguinte a segunda rejeicao. Tolerancia do nivel e proporcional ao range
 * mediano recente (proxy de ATR), nao um valor fixo em pontos.
 */
function detectDoubleRejection(candles: Candle[]): RawSignal[] {
  const out: RawSignal[] = [];
  for (let i = DOUBLE_REJECTION_MEDIAN_LOOKBACK; i < candles.length - 1; i++) {
    const medianRange = median(candles.slice(i - DOUBLE_REJECTION_MEDIAN_LOOKBACK, i).map(candleRange));
    if (medianRange === 0) continue;
    const tolerance = medianRange * DOUBLE_REJECTION_LEVEL_TOLERANCE_RATIO;

    const second = candles[i]!;
    const secondLowerWick = lowerWickPercentage(second);
    const secondUpperWick = upperWickPercentage(second);

    const searchStart = Math.max(0, i - DOUBLE_REJECTION_SEARCH_WINDOW);
    const searchEnd = i - DOUBLE_REJECTION_MIN_GAP;

    let matched: { direction: Direction; wick: number } | null = null;

    if (secondLowerWick !== null && secondLowerWick >= DOUBLE_REJECTION_MIN_WICK_PERCENT) {
      for (let k = searchStart; k <= searchEnd; k++) {
        const first = candles[k]!;
        const firstLowerWick = lowerWickPercentage(first);
        if (firstLowerWick === null || firstLowerWick < DOUBLE_REJECTION_MIN_WICK_PERCENT) continue;
        if (Math.abs(second.low - first.low) > tolerance) continue;
        if (second.low < first.low - tolerance) continue; // rompeu significativamente abaixo da primeira — nao conta
        matched = { direction: 'CALL', wick: Math.min(firstLowerWick, secondLowerWick) };
        break;
      }
    }

    if (!matched && secondUpperWick !== null && secondUpperWick >= DOUBLE_REJECTION_MIN_WICK_PERCENT) {
      for (let k = searchStart; k <= searchEnd; k++) {
        const first = candles[k]!;
        const firstUpperWick = upperWickPercentage(first);
        if (firstUpperWick === null || firstUpperWick < DOUBLE_REJECTION_MIN_WICK_PERCENT) continue;
        if (Math.abs(second.high - first.high) > tolerance) continue;
        if (second.high > first.high + tolerance) continue; // rompeu significativamente acima da primeira — nao conta
        matched = { direction: 'PUT', wick: Math.min(firstUpperWick, secondUpperWick) };
        break;
      }
    }

    if (!matched) continue;
    out.push({ entryIndex: i + 1, direction: matched.direction, setupWindow: [second], signalMetricValue: matched.wick });
  }
  return out;
}

// ---- Suporte e Resistencia (baseada em indicador: zigzag + CCI + Bandas de Bollinger) ----

// Parametros fixos da estrategia (nao editaveis pelo usuario, igual as demais classicas) —
// ajustados pro timeframe M1 das velas usadas pelo app.
const SR_ZIGZAG_THRESHOLD_PCT = 0.05; // 5% de reversao pra confirmar um topo/fundo no zigzag
const SR_LEVEL_TOLERANCE_PCT = 0.0015; // 0.15% — o quao perto um pivo precisa estar de outro pra contar como "o mesmo nivel"
const SR_MIN_TOUCHES = 2; // um nivel so e valido (suporte/resistencia de verdade) se o preco ja reverteu ali pelo menos 2 vezes
const SR_MIN_WICK_PERCENT = 0.3; // pavio de rejeicao minimo na vela de sinal (0..1 do range)
const SR_CCI_PERIOD = 14;
const SR_CCI_THRESHOLD = 100; // |CCI| >= 100 = sobrecomprado/sobrevendido (velocidade exaurida)
const SR_BOLLINGER_PERIOD = 20;
const SR_BOLLINGER_STDDEV = 2;
const SR_BOLLINGER_TOLERANCE = 0.002; // 0.2% de folga pra contar como "perto o suficiente" da banda
const SR_MIN_HISTORY = Math.max(SR_BOLLINGER_PERIOD, SR_CCI_PERIOD) + 10; // velas minimas antes de avaliar qualquer sinal

export interface SRLevel {
  price: number;
  touches: number;
}

/** Agrupa pivos do mesmo tipo que estao a `tolerancePct` de distancia uns dos outros em niveis —
 * so devolve os que foram tocados pelo menos `minTouches` vezes (niveis "validados" pelo mercado). */
function buildLevels(
  pivots: { price: number; type: 'high' | 'low' }[],
  type: 'high' | 'low',
  tolerancePct: number,
  minTouches: number
): SRLevel[] {
  const prices = pivots
    .filter((p) => p.type === type)
    .map((p) => p.price)
    .sort((a, b) => a - b);
  const levels: SRLevel[] = [];
  for (const price of prices) {
    const existing = levels.find((l) => Math.abs(price - l.price) / l.price <= tolerancePct);
    if (existing) {
      existing.price = (existing.price * existing.touches + price) / (existing.touches + 1);
      existing.touches++;
    } else {
      levels.push({ price, touches: 1 });
    }
  }
  return levels.filter((l) => l.touches >= minTouches);
}

// Num historico longo (1+ dia de M1), ativos mais volateis acumulam muitos niveis validados —
// a maioria longe demais do preco atual pra ser acionavel, so poluindo o grafico. Filtra pelos
// mais PROXIMOS do preco agora e limita a quantidade, mostrando so os mais fortes (mais toques)
// entre esses.
const SR_LEVEL_MAX_DISTANCE_PCT = 0.08; // so niveis a ate 8% do preco atual
const SR_LEVEL_MAX_COUNT = 3; // no maximo 3 suportes + 3 resistencias

/** Niveis de suporte/resistencia validados (2+ toques) a partir do historico MAIS RECENTE
 * disponivel — para desenhar no grafico (ver POST /api/support-resistance-levels), nao para
 * decidir sinal (essa logica, com o cuidado de nao vazar informacao do futuro, fica em
 * `detectSupportResistance`). Usa TODOS os pivos do historico, ja que aqui so interessa "quais
 * sao os niveis relevantes agora", nao "o que era conhecido num ponto especifico do passado". */
export function getCurrentSupportResistanceLevels(candles: Candle[]): { support: SRLevel[]; resistance: SRLevel[] } {
  const pivots = zigzagPivots(candles, SR_ZIGZAG_THRESHOLD_PCT);
  const currentPrice = candles[candles.length - 1]?.close;

  const nearbyAndStrongest = (levels: SRLevel[]): SRLevel[] => {
    const nearby =
      currentPrice === undefined
        ? levels
        : levels.filter((l) => Math.abs(l.price - currentPrice) / currentPrice <= SR_LEVEL_MAX_DISTANCE_PCT);
    return nearby
      .slice()
      .sort((a, b) => b.touches - a.touches)
      .slice(0, SR_LEVEL_MAX_COUNT);
  };

  return {
    support: nearbyAndStrongest(buildLevels(pivots, 'low', SR_LEVEL_TOLERANCE_PCT, SR_MIN_TOUCHES)),
    resistance: nearbyAndStrongest(buildLevels(pivots, 'high', SR_LEVEL_TOLERANCE_PCT, SR_MIN_TOUCHES)),
  };
}

/**
 * Suporte e Resistencia: o preco testa um nivel validado (2+ toques anteriores, achados via
 * zigzag) com rejeicao na propria vela (pavio do lado do nivel), CCI em sobrecompra/sobrevenda
 * (velocidade/momentum esticado) e fechamento perto/alem da Banda de Bollinger (variacao
 * tambem esticada) — tres confirmacoes independentes concordando, nao so o formato de uma vela
 * isolada. Entra na vela seguinte, na direcao da reversao esperada.
 */
function detectSupportResistance(candles: Candle[]): RawSignal[] {
  const out: RawSignal[] = [];
  if (candles.length < SR_MIN_HISTORY + 1) return out;

  // Calculados UMA vez pra todo o array (cada um e O(n)) — bem mais barato que recalcular a
  // cada vela avaliada. `confirmedAt` de cada pivo garante que nenhum nivel usa informacao que
  // so ficou disponivel DEPOIS da vela de sinal (ver zigzagPivots em shared/src/indicators.ts).
  const allPivots = zigzagPivots(candles, SR_ZIGZAG_THRESHOLD_PCT);
  const cciValues = cci(candles, SR_CCI_PERIOD);
  const bands = bollingerBands(candles, SR_BOLLINGER_PERIOD, SR_BOLLINGER_STDDEV);

  for (let i = SR_MIN_HISTORY; i < candles.length - 1; i++) {
    const knownPivots = allPivots.filter((p) => p.confirmedAt < i);
    if (knownPivots.length === 0) continue;

    const cciNow = cciValues[i];
    const band = bands[i];
    if (cciNow == null || !band) continue;

    const signal = candles[i]!;
    const lowerWick = lowerWickPercentage(signal);
    const upperWick = upperWickPercentage(signal);

    // Suporte: toque no fundo (nivel validado) + rejeicao pra cima + CCI sobrevendido +
    // fechamento perto/abaixo da banda inferior.
    const supportLevels = buildLevels(knownPivots, 'low', SR_LEVEL_TOLERANCE_PCT, SR_MIN_TOUCHES);
    const touchedSupport = supportLevels.find(
      (l) => signal.low <= l.price * (1 + SR_LEVEL_TOLERANCE_PCT) && signal.low >= l.price * (1 - SR_LEVEL_TOLERANCE_PCT * 3)
    );
    if (
      touchedSupport &&
      lowerWick !== null &&
      lowerWick >= SR_MIN_WICK_PERCENT &&
      cciNow <= -SR_CCI_THRESHOLD &&
      signal.close <= band.lower * (1 + SR_BOLLINGER_TOLERANCE)
    ) {
      out.push({
        entryIndex: i + 1,
        direction: 'CALL',
        setupWindow: candles.slice(Math.max(0, i - 5), i + 1),
        signalMetricValue: touchedSupport.touches,
      });
      continue;
    }

    // Resistencia: toque no topo (nivel validado) + rejeicao pra baixo + CCI sobrecomprado +
    // fechamento perto/acima da banda superior.
    const resistanceLevels = buildLevels(knownPivots, 'high', SR_LEVEL_TOLERANCE_PCT, SR_MIN_TOUCHES);
    const touchedResistance = resistanceLevels.find(
      (l) => signal.high >= l.price * (1 - SR_LEVEL_TOLERANCE_PCT) && signal.high <= l.price * (1 + SR_LEVEL_TOLERANCE_PCT * 3)
    );
    if (
      touchedResistance &&
      upperWick !== null &&
      upperWick >= SR_MIN_WICK_PERCENT &&
      cciNow >= SR_CCI_THRESHOLD &&
      signal.close >= band.upper * (1 - SR_BOLLINGER_TOLERANCE)
    ) {
      out.push({
        entryIndex: i + 1,
        direction: 'PUT',
        setupWindow: candles.slice(Math.max(0, i - 5), i + 1),
        signalMetricValue: touchedResistance.touches,
      });
    }
  }

  return out;
}

function detectSignals(candles: Candle[], strategy: ClassicStrategyConfig): RawSignal[] {
  switch (strategy.id) {
    case 'sequence_reversal':
      return detectSequenceReversal(candles, strategy.params);
    case 'engulfing':
      return detectEngulfing(candles, strategy.params);
    case 'pin_bar':
      return detectPinBar(candles, strategy.params);
    case 'impulse_pullback':
      return detectImpulsePullback(candles, strategy.params);
    case 'compression_breakout':
      return detectCompressionBreakout(candles, strategy.params);
    case 'inside_bar_breakout':
      return detectInsideBarBreakout(candles);
    case 'fakeout':
      return detectFakeout(candles);
    case 'three_soldiers':
      return detectThreeSoldiers(candles);
    case 'impulse_pullback_50':
      return detectImpulsePullback50(candles);
    case 'double_rejection':
      return detectDoubleRejection(candles);
    case 'support_resistance':
      return detectSupportResistance(candles);
  }
}

export interface StrategyProgress {
  /** Quantas confirmacoes do setup ja estao em pe, contando a ATUAL (ultima vela fechada). */
  stage: number;
  /** Quantas confirmacoes o setup inteiro precisa antes da entrada. */
  totalStages: number;
  /** So conhecida quando o setup de fato completa (stage === totalStages) — null enquanto so
   * parcialmente formado, pra nao sugerir uma direcao que ainda pode nao se confirmar. */
  direction: Direction | null;
  /** true = a proxima vela (que vai comecar agora) e a entrada — equivalente a `detectPendingSignal`. */
  readyNow: boolean;
}

/**
 * Progresso parcial do setup (quantas confirmacoes de N ja estao em pe) — SO pras familias que
 * sao literalmente uma sequencia de velas em construcao (reversao apos sequencia, 3 Candles de
 * Impulso, Compressao->Breakout, Inside Bar, Dupla Rejeicao, Impulso+Pullback). As demais
 * (Engolfo, Pin Bar, Falso Rompimento, Suporte/Resistencia) nao tem uma nocao de "quantidade de
 * velas" — sao uma condicao que bate ou nao bate numa vela so (ou, no caso de Suporte/
 * Resistencia, numa combinacao de indicadores) — pra essas, null aqui significa "sem estagio
 * parcial", e o chamador (detectStrategyProgress) usa so o binario de detectPendingSignal.
 */
function detectPartialProgress(candles: Candle[], strategy: ClassicStrategyConfig): { stage: number; totalStages: number } | null {
  if (candles.length === 0) return null;
  const last = candles[candles.length - 1]!;

  switch (strategy.id) {
    case 'sequence_reversal': {
      const p = strategy.params;
      const totalStages = p.sequenceLength + 1;
      const lastColor = candleColor(last);
      if (lastColor === 'DOJI') return null;
      let run = 1;
      for (let i = candles.length - 2; i >= 0 && run < p.sequenceLength; i--) {
        if (candleColor(candles[i]!) === lastColor) run++;
        else break;
      }
      return { stage: run, totalStages };
    }

    case 'three_soldiers': {
      const totalStages = 3;
      let stage = 0;
      let prevClose: number | null = null;
      let runColor: 'G' | 'R' | null = null;
      // Anda de tras pra frente contando quantas velas recentes, em sequencia, ja cumprem
      // sozinhas o padrao (cor + corpo forte + pavio oposto pequeno) E progridem na mesma
      // direcao da vela seguinte (mais recente) — para no primeiro candle que quebra alguma regra.
      for (let i = candles.length - 1; i >= 0 && stage < totalStages; i--) {
        const c = candles[i]!;
        const color = candleColor(c);
        if (color === 'DOJI') break;
        if (runColor === null) runColor = color;
        else if (color !== runColor) break;

        const body = bodyPercentage(c);
        const oppositeWick = runColor === 'G' ? upperWickPercentage(c) : lowerWickPercentage(c);
        if (body === null || body < THREE_SOLDIERS_MIN_BODY_PERCENT) break;
        if (oppositeWick === null || oppositeWick > THREE_SOLDIERS_MAX_OPPOSITE_WICK_PERCENT) break;

        if (prevClose !== null) {
          const progressing = runColor === 'G' ? prevClose > c.close : prevClose < c.close;
          if (!progressing) break;
        }
        prevClose = c.close;
        stage++;
      }
      return stage > 0 ? { stage, totalStages } : null;
    }

    case 'compression_breakout': {
      const p = strategy.params;
      const totalStages = p.compressionLength + 1;
      if (candles.length <= p.medianLookback + p.compressionLength) return null;
      const lookback = candles.slice(candles.length - 1 - p.compressionLength - p.medianLookback, candles.length - 1 - p.compressionLength);
      const medianRange = median(lookback.map(candleRange));
      if (medianRange === 0) return null;
      let stage = 0;
      for (let i = candles.length - 1; i >= 0 && stage < p.compressionLength; i--) {
        if (candleRange(candles[i]!) <= medianRange * p.maxCompressionRangeRatio) stage++;
        else break;
      }
      return stage > 0 ? { stage, totalStages } : null;
    }

    case 'inside_bar_breakout': {
      // 2 estagios: 1) ja existe pelo menos 1 inside bar dentro do range de uma vela-mae
      // recente; 2) a vela atual rompe esse range (pronta — ver detectPendingSignal).
      if (candles.length < 2) return null;
      const mother = candles[candles.length - 2]!;
      const current = candles[candles.length - 1]!;
      const isInsideSoFar = current.high < mother.high && current.low > mother.low;
      return isInsideSoFar ? { stage: 1, totalStages: 2 } : null;
    }

    case 'double_rejection': {
      const p = DOUBLE_REJECTION_MEDIAN_LOOKBACK;
      if (candles.length <= p) return null;
      const medianRange = median(candles.slice(candles.length - 1 - p, candles.length - 1).map(candleRange));
      if (medianRange === 0) return null;
      const searchEnd = candles.length - 1 - DOUBLE_REJECTION_MIN_GAP;
      const searchStart = Math.max(0, candles.length - 1 - DOUBLE_REJECTION_SEARCH_WINDOW);
      for (let k = searchStart; k <= searchEnd; k++) {
        const first = candles[k]!;
        const firstLowerWick = lowerWickPercentage(first);
        const firstUpperWick = upperWickPercentage(first);
        if (
          (firstLowerWick !== null && firstLowerWick >= DOUBLE_REJECTION_MIN_WICK_PERCENT) ||
          (firstUpperWick !== null && firstUpperWick >= DOUBLE_REJECTION_MIN_WICK_PERCENT)
        ) {
          return { stage: 1, totalStages: 2 }; // ja ha uma 1a rejeicao valida esperando a 2a testar o mesmo nivel
        }
      }
      return null;
    }

    case 'impulse_pullback':
    case 'impulse_pullback_50': {
      const lookback = strategy.id === 'impulse_pullback' ? strategy.params.medianLookback : IMPULSE_PULLBACK_50_MEDIAN_LOOKBACK;
      const minMultiplier =
        strategy.id === 'impulse_pullback' ? strategy.params.minImpulseRangeMultiplier : IMPULSE_PULLBACK_50_MIN_IMPULSE_MULTIPLIER;
      if (candles.length <= lookback) return null;
      const window = candles.slice(candles.length - 1 - lookback, candles.length - 1);
      const medianRange = median(window.map(candleRange));
      if (medianRange === 0) return null;
      const impulse = candles[candles.length - 1]!;
      const impulseColor = candleColor(impulse);
      if (impulseColor === 'DOJI') return null;
      if (candleRange(impulse) < medianRange * minMultiplier) return null;
      return { stage: 1, totalStages: 2 }; // impulso acabou de fechar — falta so o pullback confirmar
    }

    // Engolfo, Pin Bar, Falso Rompimento e Suporte/Resistencia nao tem "quantidade de velas"
    // parcial — ou a condicao bate numa vela so, ou nao bate ainda (ver detectStrategyProgress).
    case 'engulfing':
    case 'pin_bar':
    case 'fakeout':
    case 'support_resistance':
      return null;
  }
}

/**
 * Visao combinada pra lista de vigilancia: progresso parcial (quando a familia tiver essa
 * nocao) + o binario real de "pronta agora" (sempre via detectPendingSignal, o MESMO caminho
 * testado que decide a entrada de verdade — nunca diverge). Devolve null quando nao ha
 * absolutamente nada em andamento (nem parcial, nem pronto).
 */
export function detectStrategyProgress(closedCandles: Candle[], strategy: ClassicStrategyConfig): StrategyProgress | null {
  const ready = detectPendingSignal(closedCandles, strategy);
  const partial = detectPartialProgress(closedCandles, strategy);

  if (ready) {
    const totalStages = partial?.totalStages ?? 1;
    return { stage: totalStages, totalStages, direction: ready.direction, readyNow: true };
  }
  if (partial) {
    return { stage: partial.stage, totalStages: partial.totalStages, direction: null, readyNow: false };
  }
  return null;
}

/**
 * Verifica se o setup da estrategia ACABOU de se completar na ultima vela fechada — ou seja,
 * se a vela que esta se formando agora e a entrada (compra/venda). Reaproveita os mesmos
 * detectores de `runClassicStrategy` sem duplicar logica: cada detector so olha pra tras do
 * indice de entrada pra casar o setup (o candle de entrada em si so e lido DEPOIS, so pra
 * classificar WIN/LOSS) — entao basta um candle "dummy" no fim (nunca lido pelo matching) pra
 * satisfazer o `candles[entryIndex]` que os loops exigem, e filtrar pelas ocorrencias cujo
 * entryIndex caia EXATAMENTE nesse dummy (ou seja, a entrada ainda nao aconteceu de verdade).
 */
export function detectPendingSignal(
  closedCandles: Candle[],
  strategy: ClassicStrategyConfig
): { direction: Direction; signalMetricValue: number } | null {
  if (closedCandles.length === 0) return null;
  const last = closedCandles[closedCandles.length - 1]!;
  const dummy: Candle = { ...last, from: last.to, to: last.to + (last.to - last.from), isClosed: false };
  const withDummy = [...closedCandles, dummy];

  const signals = detectSignals(withDummy, strategy);
  const pending = signals.find((s) => s.entryIndex === closedCandles.length);
  if (!pending) return null;
  return { direction: pending.direction, signalMetricValue: pending.signalMetricValue };
}

/** Inicio (epoch seconds, UTC) do dia de calendario de hoje — "dia" no seletor "Dias" da tela
 * do Grafico significa dia de CALENDARIO, nao uma janela rolante de 24h: com Dias=1, o
 * historico deve comecar na abertura de HOJE (00:00 UTC), nao "24h atras agora", que podia
 * incluir pedaco de ontem e cortar fora parte de hoje dependendo da hora do clique. */
export function startOfTodayUtc(): number {
  const now = new Date();
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000);
}

/** So o fetch (parte lenta, de rede) — separado do calculo pra poder buscar o historico UMA
 * vez e rodar varias estrategias em cima do mesmo array (ver runAllClassicStrategiesForAsset).
 * `days` conta dias de CALENDARIO incluindo hoje (days=1 -> so hoje; days=7 -> hoje + 6 dias
 * anteriores, cada um comecando na propria abertura) — ver startOfTodayUtc. */
export async function fetchClosedCandles(broker: BrokerAdapter, activeId: number, days: number): Promise<Candle[]> {
  const now = Math.floor(Date.now() / 1000);
  const from = startOfTodayUtc() - (days - 1) * 24 * 60 * 60;
  return (await broker.getHistoricalCandles(activeId, CANDLE_SIZE_M1, from, now))
    .filter((c) => c.isClosed)
    .sort((a, b) => a.from - b.from);
}

/** So o calculo, a partir de candles ja buscados (ver fetchClosedCandles). */
export function computeClassicStrategyResult(
  candles: Candle[],
  activeId: number,
  days: number,
  strategy: ClassicStrategyConfig
): ClassicStrategyResult {
  const rawSignals = detectSignals(candles, strategy);

  const occurrences: ClassicOccurrence[] = rawSignals.map((s) => {
    const setupLast = s.setupWindow[s.setupWindow.length - 1]!;
    const entryCandle = candles[s.entryIndex];
    const reentryCandle = candles[s.entryIndex + 1];
    return {
      id: `classic-${strategy.id}-${activeId}-${setupLast.to}-${randomUUID()}`,
      activeId,
      occurredAt: setupLast.to,
      setupWindow: s.setupWindow,
      direction: s.direction,
      entryCandle,
      result: entryCandle ? computeResultForDirection(entryCandle, s.direction) : undefined,
      reentryCandle,
      signalMetricValue: s.signalMetricValue,
    };
  });

  let wins = 0;
  let losses = 0;
  let dojis = 0;
  let metricSum = 0;
  for (const o of occurrences) {
    if (o.result === 'WIN') wins++;
    else if (o.result === 'LOSS') losses++;
    else if (o.result === 'DOJI') dojis++;
    metricSum += o.signalMetricValue;
  }

  return {
    activeId,
    days,
    strategy,
    occurrences,
    summary: { wins, losses, dojis },
    signalMetricLabel: SIGNAL_METRIC_LABEL[strategy.id],
    avgSignalMetricValue: occurrences.length > 0 ? metricSum / occurrences.length : 0,
    reentry: buildReentrySummary(occurrences),
  };
}

export async function runClassicStrategy(
  broker: BrokerAdapter,
  activeId: number,
  days: number,
  strategy: ClassicStrategyConfig
): Promise<ClassicStrategyResult> {
  const candles = await fetchClosedCandles(broker, activeId, days);
  return computeClassicStrategyResult(candles, activeId, days, strategy);
}

/** Roda todas as estrategias classicas pra um ativo, buscando o historico UMA unica vez. */
export async function runAllClassicStrategiesForAsset(
  broker: BrokerAdapter,
  activeId: number,
  days: number,
  strategies: ClassicStrategyConfig[]
): Promise<ClassicStrategyResult[]> {
  const candles = await fetchClosedCandles(broker, activeId, days);
  return strategies.map((strategy) => computeClassicStrategyResult(candles, activeId, days, strategy));
}

/**
 * Gale 1 (mesma logica do padrao customizado, ver backtestRunner.ts): WIN direto se a 1a
 * entrada ja ganhou; se perdeu, o resultado passa a ser o da reentrada no candle seguinte,
 * simulada nas duas direcoes possiveis. Aqui cada ocorrencia tem sua PROPRIA direcao (nao uma
 * unica direcao fixa para toda a corrida), entao "mesma direcao"/"oposta" sao relativas a
 * direcao daquela ocorrencia especifica.
 */
function buildReentrySummary(occurrences: ClassicOccurrence[]): ClassicStrategyResult['reentry'] {
  const tally = (results: TradeResult[]) => {
    let wins = 0;
    let losses = 0;
    let dojis = 0;
    for (const r of results) {
      if (r === 'WIN') wins++;
      else if (r === 'LOSS') losses++;
      else dojis++;
    }
    return { wins, losses, dojis };
  };

  const combinedSame: TradeResult[] = [];
  const combinedOpposite: TradeResult[] = [];
  const reentryOnlySame: TradeResult[] = [];
  const reentryOnlyOpposite: TradeResult[] = [];
  let consideredLosses = 0;
  let missingReentryCandle = 0;

  for (const o of occurrences) {
    if (o.result === undefined) continue;
    if (o.result !== 'LOSS') {
      combinedSame.push(o.result);
      combinedOpposite.push(o.result);
      continue;
    }
    consideredLosses++;
    if (!o.reentryCandle) {
      missingReentryCandle++;
      continue;
    }
    const opposite = oppositeDirection(o.direction);
    const sameResult = computeResultForDirection(o.reentryCandle, o.direction);
    const oppositeResult = computeResultForDirection(o.reentryCandle, opposite);
    combinedSame.push(sameResult);
    combinedOpposite.push(oppositeResult);
    reentryOnlySame.push(sameResult);
    reentryOnlyOpposite.push(oppositeResult);
  }

  return {
    combinedSameDirection: tally(combinedSame),
    combinedOppositeDirection: tally(combinedOpposite),
    reentryOnlySameDirection: tally(reentryOnlySame),
    reentryOnlyOppositeDirection: tally(reentryOnlyOpposite),
    consideredLosses,
    missingReentryCandle,
  };
}
