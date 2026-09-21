import { randomUUID } from 'node:crypto';
import {
  CANDLE_SIZE_M1,
  bodyPercentage,
  candleColor,
  lowerWickPercentage,
  upperWickPercentage,
  type Candle,
  type ClassicOccurrence,
  type ClassicStrategyConfig,
  type ClassicStrategyResult,
  type Direction,
} from '@polarium12c/shared';
import type { BrokerAdapter } from '../broker/BrokerAdapter.js';
import { computeResultForDirection } from '../util/tradeResult.js';

/**
 * Motores de deteccao das 5 familias de estrategias classicas (ver shared/src/classicStrategies.ts
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
  }
}

export async function runClassicStrategy(
  broker: BrokerAdapter,
  activeId: number,
  days: number,
  strategy: ClassicStrategyConfig
): Promise<ClassicStrategyResult> {
  const now = Math.floor(Date.now() / 1000);
  const from = now - days * 24 * 60 * 60;
  const candles = (await broker.getHistoricalCandles(activeId, CANDLE_SIZE_M1, from, now))
    .filter((c) => c.isClosed)
    .sort((a, b) => a.from - b.from);

  const rawSignals = detectSignals(candles, strategy);

  const occurrences: ClassicOccurrence[] = rawSignals.map((s) => {
    const setupLast = s.setupWindow[s.setupWindow.length - 1]!;
    const entryCandle = candles[s.entryIndex];
    return {
      id: `classic-${strategy.id}-${activeId}-${setupLast.to}-${randomUUID()}`,
      activeId,
      occurredAt: setupLast.to,
      setupWindow: s.setupWindow,
      direction: s.direction,
      entryCandle,
      result: entryCandle ? computeResultForDirection(entryCandle, s.direction) : undefined,
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
  };
}
