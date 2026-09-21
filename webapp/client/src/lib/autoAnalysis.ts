import type { AssetInfo, Direction, PatternOccurrence } from '@polarium12c/shared';
import { api } from '../api.js';
import type { AssetTally, AutoAnalysisState } from '../components/AutoAnalysisCard.js';

// Ativos sao consultados alguns por vez (nao um a um, nao todos de uma vez): sequencial pura
// levava minutos com dezenas de ativos OTC digital (cada um e uma chamada de rede real a
// corretora + gravacao no banco); paralelismo total demais arrisca sobrecarregar a mesma
// conexao WS compartilhada com a Polarium.
const ANALYSIS_CONCURRENCY = 6;

function addTally(into: AssetTally, from: AssetTally): void {
  into.wins += from.wins;
  into.losses += from.losses;
  into.dojis += from.dojis;
}

/**
 * Roda o backtest consolidado (nao dia-a-dia) + Gale 1 sobre uma lista de ativos, para o
 * padrao informado (por id, ou o padrao ativo quando `patternId` e omitido). Compartilhado
 * entre a analise geral do Monitor e a analise "teste este padrao" da tela de Padrao, para
 * nao duplicar a logica do pool de workers.
 */
export async function runAutoAnalysisScan(
  allAssets: AssetInfo[],
  days: number,
  patternId: string | undefined,
  entryDirection: Direction,
  onProgress: (state: Extract<AutoAnalysisState, { status: 'loading' }>) => void
): Promise<Extract<AutoAnalysisState, { status: 'done' }>> {
  const startedAt = Date.now();
  onProgress({ status: 'loading', completed: 0, total: allAssets.length, currentAssetName: allAssets[0]?.name ?? null, elapsedMs: 0, days });

  const overall: AssetTally = { wins: 0, losses: 0, dojis: 0 };
  const perAsset: Record<number, AssetTally> = {};
  // Guardado para poder mostrar, por ativo, qual foi o padrao de velas de cada ocorrencia
  // (ex.: "quais entradas formaram os 5 wins seguidos"), nao so o placar agregado.
  const occurrencesByAsset: Record<number, PatternOccurrence[]> = {};
  let failedCount = 0;
  let completed = 0;
  // Gale 1 e sempre calculado (nao depende de nenhuma configuracao) para comparar direto
  // com "so 1a entrada" (overall/perAsset acima).
  const reentry = {
    combinedSameDirection: { wins: 0, losses: 0, dojis: 0 } as AssetTally,
    combinedOppositeDirection: { wins: 0, losses: 0, dojis: 0 } as AssetTally,
    reentryOnlySameDirection: { wins: 0, losses: 0, dojis: 0 } as AssetTally,
    reentryOnlyOppositeDirection: { wins: 0, losses: 0, dojis: 0 } as AssetTally,
    consideredLosses: 0,
    missingCandle14: 0,
  };

  let nextIndex = 0;
  async function worker() {
    while (nextIndex < allAssets.length) {
      const asset = allAssets[nextIndex++]!;
      try {
        const { summary, occurrences } = await api.runBacktest([asset.id], days, patternId);
        const t = summary.perAsset[asset.id] ?? summary.allOccurrences;
        perAsset[asset.id] = t;
        occurrencesByAsset[asset.id] = occurrences;
        overall.wins += t.wins;
        overall.losses += t.losses;
        overall.dojis += t.dojis;

        addTally(reentry.combinedSameDirection, summary.reentry.combinedSameDirection);
        addTally(reentry.combinedOppositeDirection, summary.reentry.combinedOppositeDirection);
        addTally(reentry.reentryOnlySameDirection, summary.reentry.reentryOnlySameDirection);
        addTally(reentry.reentryOnlyOppositeDirection, summary.reentry.reentryOnlyOppositeDirection);
        reentry.consideredLosses += summary.reentry.consideredLosses;
        reentry.missingCandle14 += summary.reentry.missingCandle14;
      } catch {
        failedCount++;
      }
      completed++;
      onProgress({ status: 'loading', completed, total: allAssets.length, currentAssetName: asset.name, elapsedMs: Date.now() - startedAt, days });
    }
  }

  const workerCount = Math.min(ANALYSIS_CONCURRENCY, allAssets.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return {
    status: 'done',
    overall,
    perAsset,
    occurrencesByAsset,
    assets: allAssets,
    failedCount,
    elapsedMs: Date.now() - startedAt,
    days,
    reentry,
    entryDirection,
  };
}
