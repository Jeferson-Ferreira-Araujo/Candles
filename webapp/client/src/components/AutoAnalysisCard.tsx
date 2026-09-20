import type { AutoAnalysisState } from '../App.js';

function winRate(t: { wins: number; losses: number; dojis: number }): number | null {
  const total = t.wins + t.losses + t.dojis;
  return total > 0 ? t.wins / total : null;
}

function formatPct(p: number | null): string {
  return p === null ? '—' : `${(p * 100).toFixed(1)}%`;
}

/**
 * Consolidado (nao dia-a-dia) dos ultimos 7 dias da estrategia 12 Candles sobre todos os
 * ativos OTC digital disponiveis, rodado automaticamente ao logar (ver runAutoAnalysis em App.tsx).
 */
export function AutoAnalysisCard({ state }: { state: AutoAnalysisState }) {
  if (state.status === 'idle') return null;

  if (state.status === 'loading') {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">
        Analisando os últimos 7 dias nos ativos OTC digital disponíveis...
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

  const { summary, assets } = state;
  const nameOf = (id: number) => assets.find((a) => a.id === id)?.name ?? `Ativo ${id}`;
  const overall = summary.allOccurrences;
  const overallRate = winRate(overall);

  const ranked = Object.entries(summary.perAsset)
    .map(([id, t]) => ({ id: Number(id), ...t, total: t.wins + t.losses + t.dojis, rate: winRate(t) }))
    .filter((a) => a.total > 0)
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1) || b.total - a.total);

  return (
    <div className="rounded-xl border border-sky-800 bg-sky-950/30 p-4 space-y-4">
      <div>
        <div className="font-semibold text-sky-200">Análise automática — últimos 7 dias (OTC digital)</div>
        <p className="text-xs text-slate-400 mt-0.5">
          Rodada ao logar, sobre todos os {assets.length} ativos OTC digital disponíveis. Consolidado — não é garantia futura.
        </p>
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
        <div className="text-sm text-slate-500">Nenhum sinal do padrão 12 Candles nos últimos 7 dias.</div>
      ) : (
        <div>
          <div className="text-xs text-slate-500 mb-2">Melhores ativos ({ranked.length} com sinal no período)</div>
          <div className="space-y-1">
            {ranked.map((a) => (
              <div key={a.id} className="flex items-center justify-between gap-2 text-sm bg-slate-950/40 rounded-lg px-3 py-1.5">
                <span className="truncate">{nameOf(a.id)}</span>
                <span className="flex items-center gap-3 text-xs shrink-0">
                  <span className="text-emerald-400">{a.wins}W</span>
                  <span className="text-rose-400">{a.losses}L</span>
                  {a.dojis > 0 && <span className="text-slate-400">{a.dojis}D</span>}
                  <span className="font-semibold text-white w-14 text-right">{formatPct(a.rate)}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
