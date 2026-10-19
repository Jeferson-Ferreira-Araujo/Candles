import type { ClassicStrategyId, Direction, TradeResult } from '@polarium12c/shared';
import { CLASSIC_STRATEGIES, entryDirectionOf } from '@polarium12c/shared';
import { api } from '../api.js';
import type { ChartMarker } from '../components/CandleChart.js';

export interface BestStrategyOccurrenceLike {
  occurredAt: number;
  direction: Direction;
  result?: TradeResult;
  entryAt?: number; // epoch seconds do candle de entrada (onde o resultado foi avaliado) — usado pra posicionar o marcador
}

export interface BestStrategyResult {
  kind: 'classic' | 'pattern';
  name: string;
  wins: number;
  losses: number;
  dojis: number;
  winRate: number;
  markers: ChartMarker[];
}

const MIN_OCCURRENCES = 3; // abaixo disso a taxa nao e confiavel o suficiente pra escolher como "melhor"

function winRateOf(wins: number, losses: number, dojis: number): number | null {
  const total = wins + losses + dojis;
  return total > 0 ? wins / total : null;
}

function markerFor(entryAt: number, direction: Direction, result: TradeResult | undefined): ChartMarker {
  const color = result === 'WIN' ? '#22c55e' : result === 'LOSS' ? '#f43f5e' : '#94a3b8';
  return direction === 'CALL'
    ? { time: entryAt, position: 'belowBar', color, shape: 'arrowUp', text: result ?? undefined }
    : { time: entryAt, position: 'aboveBar', color, shape: 'arrowDown', text: result ?? undefined };
}

/**
 * Roda todas as 10 estrategias classicas + o padrao customizado ativo contra um ativo, e
 * devolve a que teve a melhor taxa de acerto (entre as que tiveram pelo menos MIN_OCCURRENCES
 * ocorrencias) — pronta com os marcadores pra sobrepor no grafico de velas. Retorna null se
 * nenhuma estrategia teve ocorrencias suficientes no periodo.
 */
export async function findBestStrategy(activeId: number, days: number): Promise<BestStrategyResult | null> {
  const candidates: BestStrategyResult[] = [];

  const classicResults = await Promise.allSettled(
    CLASSIC_STRATEGIES.map((s) => api.runClassicStrategy(activeId, days, s.id as ClassicStrategyId))
  );
  classicResults.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    const result = r.value;
    const rate = winRateOf(result.summary.wins, result.summary.losses, result.summary.dojis);
    if (rate === null || result.occurrences.length < MIN_OCCURRENCES) return;
    candidates.push({
      kind: 'classic',
      name: CLASSIC_STRATEGIES[i]!.name,
      wins: result.summary.wins,
      losses: result.summary.losses,
      dojis: result.summary.dojis,
      winRate: rate,
      markers: result.occurrences
        .filter((o) => o.entryCandle)
        .map((o) => markerFor(o.entryCandle!.from, o.direction, o.result)),
    });
  });

  try {
    const activePattern = await api.getActivePattern();
    if (activePattern) {
      const direction = entryDirectionOf(activePattern.candles);
      const pattern = await api.runBacktest([activeId], days);
      const rate = winRateOf(pattern.summary.allOccurrences.wins, pattern.summary.allOccurrences.losses, pattern.summary.allOccurrences.dojis);
      if (rate !== null && pattern.occurrences.length >= MIN_OCCURRENCES) {
        candidates.push({
          kind: 'pattern',
          name: `Padrão ativo (${activePattern.name})`,
          wins: pattern.summary.allOccurrences.wins,
          losses: pattern.summary.allOccurrences.losses,
          dojis: pattern.summary.allOccurrences.dojis,
          winRate: rate,
          markers: pattern.occurrences
            .filter((o) => o.candle13)
            .map((o) => markerFor(o.candle13!.from, direction, o.result)),
        });
      }
    }
  } catch {
    // sem padrao ativo ou falha ao rodar — simplesmente nao entra na comparacao
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.winRate - a.winRate || b.wins + b.losses - (a.wins + a.losses));
  return candidates[0]!;
}
