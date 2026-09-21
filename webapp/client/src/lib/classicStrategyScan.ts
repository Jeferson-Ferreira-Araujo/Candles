import type { AssetInfo, ClassicStrategyId } from '@polarium12c/shared';
import { api } from '../api.js';
import type { ClassicScanRow, ClassicScanState } from '../components/ClassicStrategyResults.js';

// Mesmo pool de workers usado nas outras telas de analise (ver lib/autoAnalysis.ts) — testar
// cada ativo e uma chamada de rede real (busca de candles M1 + varredura da estrategia).
const SCAN_CONCURRENCY = 6;

function addTally(into: { wins: number; losses: number; dojis: number }, from: { wins: number; losses: number; dojis: number }): void {
  into.wins += from.wins;
  into.losses += from.losses;
  into.dojis += from.dojis;
}

export async function runClassicStrategyScan(
  allAssets: AssetInfo[],
  days: number,
  strategyId: ClassicStrategyId,
  onProgress: (state: Extract<ClassicScanState, { status: 'loading' }>) => void
): Promise<Extract<ClassicScanState, { status: 'done' }>> {
  const startedAt = Date.now();
  onProgress({ status: 'loading', completed: 0, total: allAssets.length, currentAssetName: allAssets[0]?.name ?? null, elapsedMs: 0, days });

  const rows: ClassicScanRow[] = [];
  const overall = { wins: 0, losses: 0, dojis: 0 };
  const reentry = {
    combinedSameDirection: { wins: 0, losses: 0, dojis: 0 },
    combinedOppositeDirection: { wins: 0, losses: 0, dojis: 0 },
    reentryOnlySameDirection: { wins: 0, losses: 0, dojis: 0 },
    reentryOnlyOppositeDirection: { wins: 0, losses: 0, dojis: 0 },
    consideredLosses: 0,
    missingReentryCandle: 0,
  };
  let failedCount = 0;
  let completed = 0;

  let nextIndex = 0;
  async function worker() {
    while (nextIndex < allAssets.length) {
      const asset = allAssets[nextIndex++]!;
      try {
        const result = await api.runClassicStrategy(asset.id, days, strategyId);
        rows.push({ activeId: asset.id, assetName: asset.name, result });
        overall.wins += result.summary.wins;
        overall.losses += result.summary.losses;
        overall.dojis += result.summary.dojis;

        addTally(reentry.combinedSameDirection, result.reentry.combinedSameDirection);
        addTally(reentry.combinedOppositeDirection, result.reentry.combinedOppositeDirection);
        addTally(reentry.reentryOnlySameDirection, result.reentry.reentryOnlySameDirection);
        addTally(reentry.reentryOnlyOppositeDirection, result.reentry.reentryOnlyOppositeDirection);
        reentry.consideredLosses += result.reentry.consideredLosses;
        reentry.missingReentryCandle += result.reentry.missingReentryCandle;
      } catch {
        failedCount++;
      }
      completed++;
      onProgress({ status: 'loading', completed, total: allAssets.length, currentAssetName: asset.name, elapsedMs: Date.now() - startedAt, days });
    }
  }

  const workerCount = Math.min(SCAN_CONCURRENCY, allAssets.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return { status: 'done', rows, overall, reentry, failedCount, elapsedMs: Date.now() - startedAt, days };
}
