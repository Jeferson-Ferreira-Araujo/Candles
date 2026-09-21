import type { DiscoveredPattern } from '@polarium12c/shared';

export interface DiscoveryRow {
  activeId: number;
  assetName: string;
  pattern: DiscoveredPattern;
}

export type DiscoveryState =
  | { status: 'idle' }
  | { status: 'loading'; completed: number; total: number; currentAssetName: string | null; elapsedMs: number; days: number }
  | { status: 'empty' }
  | { status: 'done'; rows: DiscoveryRow[]; scannedAssets: number; failedCount: number; elapsedMs: number; days: number }
  | { status: 'error'; message: string };

/** "45s", "2m 05s" — sempre em minutos+segundos, nunca so ms/segundos crus. */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

function formatPct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

interface Props {
  state: DiscoveryState;
  onUsePattern?: (row: DiscoveryRow) => void;
}

export function PatternDiscoveryResults({ state, onUsePattern }: Props) {
  if (state.status === 'idle') return null;

  if (state.status === 'loading') {
    const pct = state.total > 0 ? Math.round((state.completed / state.total) * 100) : 0;
    const etaMs = state.completed > 0 ? (state.elapsedMs / state.completed) * (state.total - state.completed) : null;
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-2">
        <div className="flex items-center justify-between text-sm text-slate-300">
          <span className="flex items-center gap-2">
            <span className="inline-block h-3 w-3 rounded-full border-2 border-sky-400 border-t-transparent animate-spin" />
            Vasculhando os últimos {state.days} dias{state.currentAssetName ? ` — ${state.currentAssetName}` : '...'}
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
        Nenhum ativo disponível para vasculhar no momento.
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div className="rounded-xl border border-rose-800 bg-rose-950/50 p-4 text-sm text-rose-300">
        Falha ao vasculhar padrões: {state.message}
      </div>
    );
  }

  const { rows, scannedAssets, failedCount, elapsedMs, days } = state;

  return (
    <div className="rounded-xl border border-sky-800 bg-sky-950/30 p-4 space-y-4">
      <div>
        <div className="font-semibold text-sky-200">
          Padrões encontrados — últimos {days} dias ({scannedAssets} ativo(s) vasculhado(s), em {formatDuration(elapsedMs)})
        </div>
        <p className="text-xs text-slate-400 mt-0.5">
          Só sequências que se repetiram pelo menos 10 vezes no mesmo dia. O pavio mostrado é da penúltima vela
          (a vela de sinal) — mínimo de 25% para ser considerado um indício forte.
        </p>
        {failedCount > 0 && (
          <p className="text-xs text-amber-400 mt-0.5">{failedCount} ativo(s) falharam ao consultar e foram ignorados.</p>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="text-sm text-slate-500">
          Nenhuma sequência se repetiu 10+ vezes no mesmo dia, para os ativos/período escolhidos.
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row, idx) => {
            const p = row.pattern;
            const wickOk = p.validSignalWickShare >= 0.5;
            return (
              <div key={`${row.activeId}-${p.sequence.join('')}-${idx}`} className="rounded-lg bg-slate-950/40 border border-slate-800 p-3 flex items-center gap-3 flex-wrap">
                <div className="flex gap-1">
                  {p.sequence.map((c, i) => (
                    <span
                      key={i}
                      className={`h-5 w-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                        c === 'G' ? 'bg-emerald-600' : 'bg-rose-600'
                      } ${i === p.sequence.length - 1 ? 'ring-2 ring-sky-400' : ''}`}
                      title={i === p.sequence.length - 1 ? 'Entrada' : i === p.sequence.length - 2 ? 'Sinal' : undefined}
                    >
                      {c}
                    </span>
                  ))}
                </div>
                <div className="flex-1 min-w-[140px]">
                  <div className="text-sm font-medium">{row.assetName}</div>
                  <div className="text-[11px] text-slate-500">
                    {p.length} velas · {p.totalOccurrences}x no período · pico de {p.bestDayCount}x em {p.bestDay}
                  </div>
                </div>
                <div className="text-xs text-right shrink-0">
                  <div className="text-slate-500">pavio do sinal (méd.)</div>
                  <div className={wickOk ? 'text-emerald-400 font-semibold' : 'text-amber-400 font-semibold'}>
                    {formatPct(p.avgSignalWickPercentage)}
                  </div>
                  <div className="text-slate-600">{formatPct(p.validSignalWickShare)} das vezes ≥ 25%</div>
                </div>
                {onUsePattern && (
                  <button
                    type="button"
                    onClick={() => onUsePattern(row)}
                    className="text-xs rounded-lg border border-emerald-700 text-emerald-300 hover:bg-emerald-950/60 px-2 py-1 shrink-0"
                  >
                    Usar este padrão →
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
