import { useState } from 'react';
import type { ClassicOccurrence, ClassicStrategyResult } from '@polarium12c/shared';
import { candleColor } from '@polarium12c/shared';

export interface ClassicScanRow {
  activeId: number;
  assetName: string;
  result: ClassicStrategyResult;
}

export type ClassicScanState =
  | { status: 'idle' }
  | { status: 'loading'; completed: number; total: number; currentAssetName: string | null; elapsedMs: number; days: number }
  | { status: 'empty' }
  | { status: 'done'; rows: ClassicScanRow[]; overall: { wins: number; losses: number; dojis: number }; failedCount: number; elapsedMs: number; days: number }
  | { status: 'error'; message: string };

const RESULT_STYLE: Record<string, string> = {
  WIN: 'bg-emerald-700 text-emerald-100',
  LOSS: 'bg-rose-700 text-rose-100',
  DOJI: 'bg-slate-700 text-slate-200',
};

function winRate(t: { wins: number; losses: number; dojis: number }): number | null {
  const total = t.wins + t.losses + t.dojis;
  return total > 0 ? t.wins / total : null;
}

function formatPct(p: number | null): string {
  return p === null ? '—' : `${(p * 100).toFixed(1)}%`;
}

/** "45s", "2m 05s" — sempre em minutos+segundos, nunca so ms/segundos crus. */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

/** Uma ocorrencia: as velas do setup (bolinhas coloridas) + a vela de entrada + o resultado real. */
function OccurrenceRow({ occurrence, signalMetricLabel }: { occurrence: ClassicOccurrence; signalMetricLabel: string }) {
  const when = new Date(occurrence.occurredAt * 1000).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const entryColor = occurrence.entryCandle ? candleColor(occurrence.entryCandle) : null;

  return (
    <div className="flex items-center gap-2 flex-wrap text-xs">
      <span className="text-slate-500 w-24 shrink-0">{when}</span>
      <div className="flex gap-0.5">
        {occurrence.setupWindow.map((c, i) => (
          <span
            key={i}
            className={`h-4 w-4 rounded-full ${
              i === occurrence.setupWindow.length - 1 ? 'ring-2 ring-amber-400' : ''
            } ${candleColor(c) === 'G' ? 'bg-emerald-600' : candleColor(c) === 'R' ? 'bg-rose-600' : 'bg-slate-500'}`}
            title={i === occurrence.setupWindow.length - 1 ? `Sinal (${candleColor(c)})` : candleColor(c)}
          />
        ))}
        {entryColor && (
          <span
            className={`h-4 w-4 rounded-full ring-2 ring-sky-400 ${entryColor === 'G' ? 'bg-emerald-600' : entryColor === 'R' ? 'bg-rose-600' : 'bg-slate-500'}`}
            title={`Entrada (${entryColor})`}
          />
        )}
      </div>
      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
        occurrence.direction === 'CALL' ? 'bg-sky-800 text-sky-100' : 'bg-fuchsia-800 text-fuchsia-100'
      }`}>
        {occurrence.direction}
      </span>
      <span className="text-slate-500" title={signalMetricLabel}>
        {(occurrence.signalMetricValue * 100).toFixed(0)}%
      </span>
      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${RESULT_STYLE[occurrence.result ?? ''] ?? 'bg-slate-800 text-slate-400'}`}>
        {occurrence.result ?? 'sem dado'}
      </span>
    </div>
  );
}

interface Props {
  state: ClassicScanState;
}

export function ClassicStrategyResults({ state }: Props) {
  const [expandedAssetId, setExpandedAssetId] = useState<number | null>(null);

  if (state.status === 'idle') return null;

  if (state.status === 'loading') {
    const pct = state.total > 0 ? Math.round((state.completed / state.total) * 100) : 0;
    const etaMs = state.completed > 0 ? (state.elapsedMs / state.completed) * (state.total - state.completed) : null;
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-2">
        <div className="flex items-center justify-between text-sm text-slate-300">
          <span className="flex items-center gap-2">
            <span className="inline-block h-3 w-3 rounded-full border-2 border-sky-400 border-t-transparent animate-spin" />
            Testando os últimos {state.days} dias{state.currentAssetName ? ` — ${state.currentAssetName}` : '...'}
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
        Nenhum ativo disponível para testar no momento.
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="rounded-xl border border-rose-800 bg-rose-950/50 p-4 text-sm text-rose-300">
        Falha ao testar a estratégia: {state.message}
      </div>
    );
  }

  const { rows, overall, failedCount, elapsedMs, days } = state;
  const overallRate = winRate(overall);
  const signalMetricLabel = rows[0]?.result.signalMetricLabel ?? 'Força do sinal';
  const ranked = [...rows]
    .filter((r) => r.result.occurrences.length > 0)
    .sort((a, b) => {
      const rb = winRate(b.result.summary) ?? -1;
      const ra = winRate(a.result.summary) ?? -1;
      return rb - ra || b.result.occurrences.length - a.result.occurrences.length;
    });

  return (
    <div className="rounded-xl border border-sky-800 bg-sky-950/30 p-4 space-y-4">
      <div>
        <div className="font-semibold text-sky-200">
          Resultado — últimos {days} dias ({rows.length} ativo(s) testado(s), em {formatDuration(elapsedMs)})
        </div>
        <p className="text-xs text-slate-400 mt-0.5">
          Consolidado — não é garantia futura. "{signalMetricLabel}" mede a força da vela de sinal de cada ocorrência —
          quanto maior, mais segura a entrada tende a ser.
        </p>
        {failedCount > 0 && (
          <p className="text-xs text-amber-400 mt-0.5">{failedCount} ativo(s) falharam ao consultar e foram ignorados.</p>
        )}
      </div>

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

      {ranked.length === 0 ? (
        <div className="text-sm text-slate-500">Nenhuma ocorrência dessa estratégia nos últimos {days} dias.</div>
      ) : (
        <div>
          <div className="text-xs text-slate-500 mb-2">
            Ativos com ocorrência ({ranked.length}) — toque para ver o detalhe de cada uma
          </div>
          <div className="space-y-1">
            {ranked.map((row) => {
              const isExpanded = expandedAssetId === row.activeId;
              const t = row.result.summary;
              const rate = winRate(t);
              const total = t.wins + t.losses + t.dojis;
              return (
                <div key={row.activeId} className="bg-slate-950/40 rounded-lg overflow-hidden">
                  <button
                    type="button"
                    onClick={() => setExpandedAssetId(isExpanded ? null : row.activeId)}
                    className="w-full flex items-center justify-between gap-2 text-sm px-3 py-1.5 hover:bg-slate-900/60"
                  >
                    <span className="truncate">{row.assetName}</span>
                    <span className="flex items-center gap-3 text-xs shrink-0">
                      <span className="text-slate-500">{total}x</span>
                      <span className="text-emerald-400">{t.wins}W</span>
                      <span className="text-rose-400">{t.losses}L</span>
                      {t.dojis > 0 && <span className="text-slate-400">{t.dojis}D</span>}
                      <span className="text-slate-500" title={`${signalMetricLabel} (média)`}>
                        {(row.result.avgSignalMetricValue * 100).toFixed(0)}%
                      </span>
                      <span className="font-semibold text-white w-14 text-right">{formatPct(rate)}</span>
                      <span className="text-slate-500">{isExpanded ? '▲' : '▼'}</span>
                    </span>
                  </button>
                  {isExpanded && (
                    <div className="border-t border-slate-800 px-3 py-2 space-y-2">
                      {row.result.occurrences.map((occ) => (
                        <OccurrenceRow key={occ.id} occurrence={occ} signalMetricLabel={signalMetricLabel} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
