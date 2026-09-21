import type { AssetInfo } from '@polarium12c/shared';
import { api } from '../api.js';
import type { DiscoveryRow, DiscoveryState } from '../components/PatternDiscoveryResults.js';

// Mesma logica de pool de workers usada na analise de padrao (ver lib/autoAnalysis.ts) —
// vasculhar o historico de cada ativo e uma chamada de rede real (busca de candles M1 +
// varredura de sequencias), entao um pool limitado evita tanto "um por um" (lento) quanto
// "todos de uma vez" (sobrecarrega a mesma conexao com a corretora).
const SCAN_CONCURRENCY = 6;

export async function runPatternDiscoveryScan(
  allAssets: AssetInfo[],
  days: number,
  onProgress: (state: Extract<DiscoveryState, { status: 'loading' }>) => void
): Promise<Extract<DiscoveryState, { status: 'done' }>> {
  const startedAt = Date.now();
  onProgress({ status: 'loading', completed: 0, total: allAssets.length, currentAssetName: allAssets[0]?.name ?? null, elapsedMs: 0, days });

  const rows: DiscoveryRow[] = [];
  let failedCount = 0;
  let completed = 0;

  let nextIndex = 0;
  async function worker() {
    while (nextIndex < allAssets.length) {
      const asset = allAssets[nextIndex++]!;
      try {
        const result = await api.discoverPatterns(asset.id, days);
        for (const pattern of result.patterns) {
          rows.push({ activeId: asset.id, assetName: asset.name, pattern });
        }
      } catch {
        failedCount++;
      }
      completed++;
      onProgress({ status: 'loading', completed, total: allAssets.length, currentAssetName: asset.name, elapsedMs: Date.now() - startedAt, days });
    }
  }

  const workerCount = Math.min(SCAN_CONCURRENCY, allAssets.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  rows.sort((a, b) => b.pattern.bestDayCount - a.pattern.bestDayCount || b.pattern.totalOccurrences - a.pattern.totalOccurrences);

  return { status: 'done', rows, scannedAssets: allAssets.length, failedCount, elapsedMs: Date.now() - startedAt, days };
}
