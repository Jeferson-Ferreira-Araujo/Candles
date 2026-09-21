import {
  CANDLE_SIZE_M1,
  candleColor,
  lowerWickPercentage,
  SIGNAL_WICK_MIN_LOWER_PERCENTAGE,
  type Candle,
  type CandleColor,
  type DiscoveredPattern,
  type PatternDiscoveryResult,
} from '@polarium12c/shared';
import type { BrokerAdapter } from '../broker/BrokerAdapter.js';

/** Padroes com menos de 4 velas nao sao uteis (curtos demais para serem um indicio real). */
export const DISCOVERY_MIN_LENGTH = 4;
/**
 * Limite pratico de tamanho pesquisado — nao e uma regra de negocio, e so para o calculo
 * terminar num tempo razoavel. Sequencias mais longas que isso e exigir 10+ repeticoes no
 * mesmo dia e estatisticamente quase impossivel de acontecer por acaso mesmo sem limite, entao
 * na pratica isso nao "esconde" padroes reais.
 */
export const DISCOVERY_MAX_LENGTH = 20;
/** So interessam sequencias que se repetiram pelo menos essa quantidade de vezes NO MESMO DIA. */
export const DISCOVERY_MIN_DAILY_REPEATS = 10;
const MAX_RESULTS = 50;

function isoDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/** Quebra a serie em "corridas" continuas de candles G/R — um DOJI quebra a corrida, ja que padroes so usam G/R (ver validatePatternCandles). */
function splitIntoRuns(candles: Candle[]): Candle[][] {
  const runs: Candle[][] = [];
  let current: Candle[] = [];
  for (const c of candles) {
    if (candleColor(c) === 'DOJI') {
      if (current.length > 0) runs.push(current);
      current = [];
      continue;
    }
    current.push(c);
  }
  if (current.length > 0) runs.push(current);
  return runs;
}

interface Accumulator {
  length: number;
  total: number;
  perDay: Map<string, number>;
  wickSum: number;
  wickCount: number;
  wickValidCount: number;
}

/**
 * Varre `candles` (ja filtrados/ordenados) procurando toda sequencia de cores de tamanho
 * DISCOVERY_MIN_LENGTH..DISCOVERY_MAX_LENGTH que se repete (janelas sobrepostas contam,
 * mesma logica de "padroes sobrepostos" usada no motor ao vivo). So retorna as que bateram
 * pelo menos DISCOVERY_MIN_DAILY_REPEATS vezes num UNICO dia — o resto e descartado por ser
 * raro demais para valer a pena testar.
 */
export function discoverPatterns(candles: Candle[]): DiscoveredPattern[] {
  const runs = splitIntoRuns(candles);
  const byKey = new Map<string, Accumulator>();

  for (const run of runs) {
    const colors = run.map((c) => candleColor(c) as CandleColor);
    const maxL = Math.min(DISCOVERY_MAX_LENGTH, run.length);

    for (let L = DISCOVERY_MIN_LENGTH; L <= maxL; L++) {
      for (let start = 0; start + L <= run.length; start++) {
        const key = colors.slice(start, start + L).join('');
        const signalCandle = run[start + L - 2]!; // penultima vela da janela — a vela de sinal
        const entryCandle = run[start + L - 1]!;
        const day = isoDate(entryCandle.to);
        const wickPct = lowerWickPercentage(signalCandle);

        let acc = byKey.get(key);
        if (!acc) {
          acc = { length: L, total: 0, perDay: new Map(), wickSum: 0, wickCount: 0, wickValidCount: 0 };
          byKey.set(key, acc);
        }
        acc.total++;
        acc.perDay.set(day, (acc.perDay.get(day) ?? 0) + 1);
        if (wickPct !== null) {
          acc.wickSum += wickPct;
          acc.wickCount++;
          if (wickPct >= SIGNAL_WICK_MIN_LOWER_PERCENTAGE) acc.wickValidCount++;
        }
      }
    }
  }

  const results: DiscoveredPattern[] = [];
  for (const [key, acc] of byKey) {
    let bestDay = '';
    let bestDayCount = 0;
    for (const [day, count] of acc.perDay) {
      if (count > bestDayCount) {
        bestDayCount = count;
        bestDay = day;
      }
    }
    if (bestDayCount < DISCOVERY_MIN_DAILY_REPEATS) continue;

    results.push({
      sequence: key.split('') as CandleColor[],
      length: acc.length,
      totalOccurrences: acc.total,
      bestDay,
      bestDayCount,
      avgSignalWickPercentage: acc.wickCount > 0 ? acc.wickSum / acc.wickCount : 0,
      validSignalWickShare: acc.wickCount > 0 ? acc.wickValidCount / acc.wickCount : 0,
    });
  }

  results.sort((a, b) => b.bestDayCount - a.bestDayCount || b.totalOccurrences - a.totalOccurrences);
  return results.slice(0, MAX_RESULTS);
}

export async function runPatternDiscovery(broker: BrokerAdapter, activeId: number, days: number): Promise<PatternDiscoveryResult> {
  const now = Math.floor(Date.now() / 1000);
  const from = now - days * 24 * 60 * 60;
  const candles = (await broker.getHistoricalCandles(activeId, CANDLE_SIZE_M1, from, now))
    .filter((c) => c.isClosed)
    .sort((a, b) => a.from - b.from);

  return { activeId, days, candleCount: candles.length, patterns: discoverPatterns(candles) };
}
