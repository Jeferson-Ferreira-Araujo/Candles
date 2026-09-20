import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { BacktestSummary, PatternOccurrence, Settings } from '@polarium12c/shared';
import { api } from '../api.js';

interface OutletCtx {
  settings: Settings | null;
}

function tallyLabel(t: { wins: number; losses: number; dojis: number }): string {
  const total = t.wins + t.losses + t.dojis;
  const winRate = total > 0 ? ((t.wins / total) * 100).toFixed(1) : '—';
  return `${t.wins} WIN / ${t.losses} LOSS / ${t.dojis} DOJI (win rate: ${winRate}%)`;
}

export function BacktestPage() {
  const { settings } = useOutletContext<OutletCtx>();
  const [activeIdsInput, setActiveIdsInput] = useState(() => (settings?.selectedActiveIds ?? []).join(', '));
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<BacktestSummary | null>(null);
  const [occurrences, setOccurrences] = useState<PatternOccurrence[]>([]);

  const activeIds = activeIdsInput
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));

  async function run() {
    setError(null);
    setLoading(true);
    try {
      const result = await api.runBacktest(activeIds, days);
      setSummary(result.summary);
      setOccurrences(result.occurrences);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Validação 30D</h1>
        <p className="text-slate-400 text-sm">
          Roda a estratégia "12 Candles" sobre o histórico M1 e registra todas as ocorrências. Histórico de
          desenvolvimento: 14/14 — isso <span className="font-semibold">não é garantia futura</span>.
        </p>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-xs text-slate-400 mb-1">Ativos (IDs separados por vírgula)</label>
          <input
            value={activeIdsInput}
            onChange={(e) => setActiveIdsInput(e.target.value)}
            placeholder="ex.: 81, 76, 2298"
            className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm w-72"
          />
        </div>
        <div>
          <label className="block text-xs text-slate-400 mb-1">Dias</label>
          <input
            type="number"
            min={1}
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm w-24"
          />
        </div>
        <button
          onClick={run}
          disabled={loading || activeIds.length === 0}
          className="rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 text-sm font-semibold"
        >
          {loading ? 'Rodando...' : 'Rodar backtest'}
        </button>
      </div>

      {error && <div className="rounded-lg border border-rose-800 bg-rose-950/50 p-3 text-sm text-rose-300">{error}</div>}

      {summary && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
              <div className="text-sm text-slate-400 mb-1">Todas as ocorrências</div>
              <div className="font-semibold">{tallyLabel(summary.allOccurrences)}</div>
            </div>
            <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
              <div className="text-sm text-slate-400 mb-1">Somente a 1ª ocorrência de cada dia</div>
              <div className="font-semibold">{tallyLabel(summary.firstOfDayOnly)}</div>
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-slate-400 border-b border-slate-800">
                  <th className="py-2 pr-4">Data</th>
                  {activeIds.map((id) => (
                    <th key={id} className="py-2 pr-4">
                      Ativo {id}
                    </th>
                  ))}
                  <th className="py-2 pr-4">Total</th>
                  <th className="py-2 pr-4">Observação</th>
                </tr>
              </thead>
              <tbody>
                {summary.perDay.map((day) => (
                  <tr key={day.date} className="border-b border-slate-900">
                    <td className="py-1.5 pr-4 text-slate-300">{day.date}</td>
                    {activeIds.map((id) => (
                      <td key={id} className="py-1.5 pr-4">
                        {day.perActive[id] ?? 0}
                      </td>
                    ))}
                    <td className="py-1.5 pr-4 font-semibold">{day.total}</td>
                    <td className="py-1.5 pr-4 text-xs text-slate-500">
                      {day.multipleDifferentActives && 'sinais em ativos diferentes '}
                      {day.multipleInSameActive && 'múltiplos no mesmo ativo '}
                      {day.bucket === 'NONE' && 'sem sinal'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
            <div className="font-semibold mb-2">Ocorrências ({occurrences.length})</div>
            <div className="max-h-80 overflow-y-auto text-sm space-y-1">
              {occurrences.map((occ) => (
                <div key={occ.id} className="flex gap-3 text-slate-300">
                  <span className="text-slate-600 w-40 shrink-0">{new Date(occ.occurredAt * 1000).toLocaleString('pt-BR')}</span>
                  <span className="w-20">Ativo {occ.activeId}</span>
                  <span className="w-20">pavio {(occ.wickPercentage11 * 100).toFixed(1)}%</span>
                  <span
                    className={
                      occ.result === 'WIN' ? 'text-emerald-400' : occ.result === 'LOSS' ? 'text-rose-400' : 'text-slate-400'
                    }
                  >
                    {occ.result ?? 'sem candle 13 disponível'}
                  </span>
                  {occ.isFirstOfDay && <span className="text-xs text-sky-400">(1ª do dia)</span>}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
