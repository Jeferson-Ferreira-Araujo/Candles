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
