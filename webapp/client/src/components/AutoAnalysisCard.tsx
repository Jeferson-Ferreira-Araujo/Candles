import { useState } from 'react';
import type { AssetInfo, Direction, PatternOccurrence } from '@polarium12c/shared';
import { ENTRY_DIRECTION, candleColor } from '@polarium12c/shared';

const OPPOSITE_DIRECTION: Direction = (ENTRY_DIRECTION as Direction) === 'PUT' ? 'CALL' : 'PUT';

const RESULT_STYLE: Record<string, string> = {
  WIN: 'bg-emerald-700 text-emerald-100',
  LOSS: 'bg-rose-700 text-rose-100',
  DOJI: 'bg-slate-700 text-slate-200',
};

export interface AssetTally {
  wins: number;
  losses: number;
  dojis: number;
}

export type AutoAnalysisState =
  | { status: 'idle' }
  | { status: 'loading'; completed: number; total: number; currentAssetName: string | null; elapsedMs: number; days: number }
  | { status: 'empty' }
  | {
      status: 'done';
      overall: AssetTally;
      perAsset: Record<number, AssetTally>;
      /** Ocorrencias cruas por ativo — usadas so pra mostrar o padrao de velas de cada entrada ao expandir um ativo no ranking. */
      occurrencesByAsset: Record<number, PatternOccurrence[]>;
      assets: AssetInfo[];
      failedCount: number;
      elapsedMs: number;
      days: number;
      /** Sempre presente (Gale 1 e calculado em toda execucao, sem depender de nenhuma configuracao). */
      reentry: {
        combinedSameDirection: AssetTally; // resultado final: 1a entrada (ENTRY_DIRECTION), e se perder, gale repetindo a mesma direcao
        combinedOppositeDirection: AssetTally; // idem, mas gale invertendo para a direcao contraria
        consideredLosses: number;
        missingCandle14: number;
      };
    }
  | { status: 'error'; message: string };

function winRate(t: { wins: number; losses: number; dojis: number }): number | null {
  const total = t.wins + t.losses + t.dojis;
  return total > 0 ? t.wins / total : null;
}

function formatPct(p: number | null): string {
  return p === null ? '—' : `${(p * 100).toFixed(1)}%`;
}

/** "45s", "2m 05s" — sempre em minutos+segundos, nunca so ms/segundos crus, pra ficar legivel numa espera longa. */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

/** Uma ocorrencia: as velas do padrao (bolinhas G/R) + a vela de entrada + o resultado real. */
function OccurrencePattern({ occurrence }: { occurrence: PatternOccurrence }) {
  const when = new Date(occurrence.occurredAt * 1000).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const entryColor = occurrence.candle13 ? candleColor(occurrence.candle13) : null;

  return (
    <div className="flex items-center gap-2 flex-wrap text-xs">
      <span className="text-slate-500 w-24 shrink-0">{when}</span>
      <div className="flex gap-0.5">
        {occurrence.candles.map((c, i) => (
          <span
            key={i}
            className={`h-4 w-4 rounded-full ${candleColor(c) === 'G' ? 'bg-emerald-600' : candleColor(c) === 'R' ? 'bg-rose-600' : 'bg-slate-500'}`}
            title={candleColor(c)}
          />
        ))}
        {entryColor && (
          <span
            className={`h-4 w-4 rounded-full ring-2 ring-sky-400 ${entryColor === 'G' ? 'bg-emerald-600' : entryColor === 'R' ? 'bg-rose-600' : 'bg-slate-500'}`}
            title={`Entrada (${entryColor})`}
          />
        )}
      </div>
      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${RESULT_STYLE[occurrence.result ?? ''] ?? 'bg-slate-800 text-slate-400'}`}>
        {occurrence.result ?? 'sem dado'}
      </span>
    </div>
  );
}

/**
 * Consolidado (nao dia-a-dia) da estrategia 12 Candles sobre todos os ativos OTC digital
 * disponiveis, na janela configurada em Settings.analysisDays — disparado pelo botao em
 * MonitorPage.
 */
interface AutoAnalysisCardProps {
  state: AutoAnalysisState;
  /** Reroda a mesma analise restrita a um unico ativo — usado pelo botao dentro do detalhe expandido. */
  onAnalyzeSingleAsset?: (asset: AssetInfo) => void;
}

export function AutoAnalysisCard({ state, onAnalyzeSingleAsset }: AutoAnalysisCardProps) {
  const [expandedAssetId, setExpandedAssetId] = useState<number | null>(null);

  if (state.status === 'idle') return null;

  if (state.status === 'loading') {
    const pct = state.total > 0 ? Math.round((state.completed / state.total) * 100) : 0;
    const etaMs = state.completed > 0 ? (state.elapsedMs / state.completed) * (state.total - state.completed) : null;
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-2">
        <div className="flex items-center justify-between text-sm text-slate-300">
          <span>
            Analisando os últimos {state.days} dias{state.currentAssetName ? ` — ${state.currentAssetName}` : '...'}
          </span>
          <span className="text-slate-500 shrink-0">
            {state.completed}/{state.total}
          </span>
        </div>
        <div className="h-2 rounded-full bg-slate-800 overflow-hidden">
          <div className="h-full bg-sky-600 transition-all duration-300" style={{ width: `${pct}%` }} />
        </div>
        <div className="text-xs text-slate-500">
          Tempo decorrido: {formatDuration(state.elapsedMs)}
          {etaMs !== null && <> · restante estimado: {formatDuration(etaMs)}</>}
        </div>
      </div>
    );
  }

  if (state.status === 'empty') {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">
        Nenhum ativo OTC digital disponível para analisar no momento.
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="rounded-xl border border-rose-800 bg-rose-950/50 p-4 text-sm text-rose-300">
        Falha ao rodar a análise automática de 7 dias: {state.message}
      </div>
    );
  }

  const { overall, perAsset, occurrencesByAsset, assets, failedCount, elapsedMs, days, reentry } = state;
  const nameOf = (id: number) => assets.find((a) => a.id === id)?.name ?? `Ativo ${id}`;
  const overallRate = winRate(overall);

  const ranked = Object.entries(perAsset)
    .map(([id, t]) => ({ id: Number(id), ...t, total: t.wins + t.losses + t.dojis, rate: winRate(t) }))
    .filter((a) => a.total > 0)
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.total - a.total);

  return (
    <div className="rounded-xl border border-sky-800 bg-sky-950/30 p-4 space-y-4">
      <div>
        <div className="font-semibold text-sky-200">Análise automática — últimos {days} dias (OTC digital)</div>
        <p className="text-xs text-slate-400 mt-0.5">
          Sobre {assets.length} ativos OTC digital disponíveis, em {formatDuration(elapsedMs)}. Consolidado — não é
          garantia futura.
        </p>
        {failedCount > 0 && (
          <p className="text-xs text-amber-400 mt-0.5">
            {failedCount} ativo(s) falharam ao consultar e foram ignorados no resultado abaixo.
          </p>
        )}
      </div>

      <div>
        <div className="text-xs text-slate-500 mb-2">Só 1ª entrada (sem Gale)</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div className="rounded-lg bg-slate-950/60 border border-slate-800 p-3">
            <div className="text-xs text-slate-500">Wins</div>
            <div className="text-lg font-bold text-emerald-400">{overall.wins}</div>
          </div>
          <div className="rounded-lg bg-slate-950/60 border border-slate-800 p-3">
            <div className="text-xs text-slate-500">Losses</div>
            <div className="text-lg font-bold text-rose-400">{overall.losses}</div>
          </div>
          <div className="rounded-lg bg-slate-950/60 border border-slate-800 p-3">
            <div className="text-xs text-slate-500">Doji</div>
            <div className="text-lg font-bold text-slate-300">{overall.dojis}</div>
          </div>
          <div className="rounded-lg bg-slate-950/60 border border-slate-800 p-3">
            <div className="text-xs text-slate-500">Assertividade</div>
            <div className="text-lg font-bold text-white">{formatPct(overallRate)}</div>
          </div>
        </div>
      </div>

      {ranked.length === 0 ? (
        <div className="text-sm text-slate-500">Nenhum sinal do padrão 12 Candles nos últimos {days} dias.</div>
      ) : (
        <div>
          <div className="text-xs text-slate-500 mb-2">
            Melhores ativos ({ranked.length} com sinal no período) — toque para ver o padrão de cada entrada
          </div>
          <div className="space-y-1">
            {ranked.map((a) => {
              const isExpanded = expandedAssetId === a.id;
              const occurrences = occurrencesByAsset[a.id] ?? [];
              return (
                <div key={a.id} className="bg-slate-950/40 rounded-lg overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setExpandedAssetId(isExpanded ? null : a.id)}
                    className="w-full flex items-center justify-between gap-2 text-sm px-3 py-1.5 hover:bg-slate-900/60"
                  >
                    <span className="truncate">{nameOf(a.id)}</span>
                    <span className="flex items-center gap-3 text-xs shrink-0">
                      <span className="text-emerald-400">{a.wins}W</span>
                      <span className="text-rose-400">{a.losses}L</span>
                      {a.dojis > 0 && <span className="text-slate-400">{a.dojis}D</span>}
                      <span className="font-semibold text-white w-14 text-right">{formatPct(a.rate)}</span>
                      <span className="text-slate-500">{isExpanded ? '▲' : '▼'}</span>
                    </span>
                  </button>
                  {isExpanded && (
                    <div className="border-t border-slate-800 px-3 py-2 space-y-2">
                      {onAnalyzeSingleAsset && (
                        <button
                          type="button"
                          onClick={() => {
                            const asset = assets.find((x) => x.id === a.id);
                            if (asset) onAnalyzeSingleAsset(asset);
                          }}
                          className="text-xs rounded-lg border border-sky-700 text-sky-300 hover:bg-sky-950/60 px-2 py-1"
                        >
                          🔁 Rodar só este ativo de novo
                        </button>
                      )}
                      {occurrences.length === 0 ? (
                        <div className="text-xs text-slate-500">Detalhe indisponível para este ativo.</div>
                      ) : (
                        occurrences.map((occ) => <OccurrencePattern key={occ.id} occurrence={occ} />)
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="border-t border-sky-900 pt-4">
        <div className="text-xs text-slate-500 mb-2">
          Com Gale 1 — se a 1ª entrada perder, reentra na vela seguinte ({reentry.consideredLosses} LOSS
          consideradas
          {reentry.missingCandle14 > 0 && `, ${reentry.missingCandle14} sem vela seguinte disponível e ignoradas`})
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <div className="rounded-lg bg-slate-950/60 border border-slate-800 p-3">
            <div className="text-xs text-slate-500 mb-1">Gale mesma direção ({ENTRY_DIRECTION})</div>
            <div className="flex items-center gap-3">
              <span className="text-emerald-400">{reentry.combinedSameDirection.wins}W</span>
              <span className="text-rose-400">{reentry.combinedSameDirection.losses}L</span>
              {reentry.combinedSameDirection.dojis > 0 && (
                <span className="text-slate-400">{reentry.combinedSameDirection.dojis}D</span>
              )}
              <span className="font-semibold text-white ml-auto">{formatPct(winRate(reentry.combinedSameDirection))}</span>
            </div>
          </div>
          <div className="rounded-lg bg-slate-950/60 border border-slate-800 p-3">
            <div className="text-xs text-slate-500 mb-1">Gale direção contrária ({OPPOSITE_DIRECTION})</div>
            <div className="flex items-center gap-3">
              <span className="text-emerald-400">{reentry.combinedOppositeDirection.wins}W</span>
              <span className="text-rose-400">{reentry.combinedOppositeDirection.losses}L</span>
              {reentry.combinedOppositeDirection.dojis > 0 && (
                <span className="text-slate-400">{reentry.combinedOppositeDirection.dojis}D</span>
              )}
              <span className="font-semibold text-white ml-auto">
                {formatPct(winRate(reentry.combinedOppositeDirection))}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
