import { useEffect, useRef, useState } from 'react';
import type { AssetInfo, ClassicStrategyId } from '@polarium12c/shared';
import { CLASSIC_STRATEGIES } from '@polarium12c/shared';
import { api } from '../api.js';
import { AssetBadgePicker } from '../components/AssetBadgePicker.js';
import { ClassicStrategyResults, type ClassicScanState } from '../components/ClassicStrategyResults.js';
import { runClassicStrategyScan } from '../lib/classicStrategyScan.js';

const DEFAULT_DAYS = 7;

/**
 * Tela "Estratégias Clássicas": deixa escolher uma de 5 familias classicas de setup (reversao
 * apos sequencia, engolfo, pin bar, impulso+pullback, compressao+breakout) e rodar contra um
 * ou varios ativos (ou todos) para ver quantas vezes aconteceu e o resultado real. Cada
 * estrategia usa sua propria definicao padrao, fixa (nao ha parametros pra ajustar aqui) —
 * o objetivo e testar a regra classica tal como ela e, nao uma variacao customizada.
 */
export function ClassicStrategiesPage() {
  const [strategyId, setStrategyId] = useState<ClassicStrategyId>('sequence_reversal');
  const [assets, setAssets] = useState<AssetInfo[]>([]);
  const [testAllAssets, setTestAllAssets] = useState(true);
  const [selectedAssetIds, setSelectedAssetIds] = useState<number[]>([]);
  const [days, setDays] = useState(DEFAULT_DAYS);
  const [scan, setScan] = useState<ClassicScanState>({ status: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const startedAt = useRef<number | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getAssets().then(setAssets).catch(() => {});
  }, []);

  useEffect(() => {
    if (scan.status !== 'loading') return;
    const interval = setInterval(() => {
      setScan((prev) => (prev.status === 'loading' && startedAt.current !== null ? { ...prev, elapsedMs: Date.now() - startedAt.current } : prev));
    }, 1000);
    return () => clearInterval(interval);
  }, [scan.status]);

  async function run() {
    const targetAssets = testAllAssets ? assets : assets.filter((a) => selectedAssetIds.includes(a.id));
    if (targetAssets.length === 0) {
      setError('Selecione pelo menos um ativo (ou marque "Testar todos os ativos") antes de rodar.');
      return;
    }
    setError(null);
    startedAt.current = Date.now();
    const result = await runClassicStrategyScan(targetAssets, days, strategyId, setScan);
    setScan(result);
    resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold">Estratégias Clássicas</h1>
        <p className="text-slate-400 text-sm">
          Escolha uma família de setup clássico e teste a regra padrão dela contra o histórico real dos ativos.
        </p>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-3">
        <div className="text-xs text-slate-500">Estratégia</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {CLASSIC_STRATEGIES.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setStrategyId(s.id)}
              className={`text-left rounded-lg border p-3 transition-colors ${
                strategyId === s.id ? 'border-sky-500 bg-sky-950/40' : 'border-slate-800 bg-slate-950/40 hover:border-slate-700'
              }`}
            >
              <div className="text-sm font-semibold">{s.name}</div>
              <div className="text-[11px] text-slate-500 mt-0.5">{s.description}</div>
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-3">
        <div className="rounded-lg bg-slate-950/40 border border-slate-800 p-3 space-y-2">
          <div className="text-xs text-slate-500">Ativos a testar</div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={testAllAssets} onChange={(e) => setTestAllAssets(e.target.checked)} className="accent-sky-500" />
            Testar todos os ativos OTC digital
          </label>
          {!testAllAssets && <AssetBadgePicker assets={assets} value={selectedAssetIds} onChange={setSelectedAssetIds} />}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-xs text-slate-400 mb-1">Dias</label>
            <input
              type="number"
              min={1}
              value={days}
              onChange={(e) => setDays(Math.max(1, Number(e.target.value)))}
              className="bg-slate-950 border border-slate-700 rounded-lg px-3 py-2 text-sm w-24"
            />
          </div>
          <button
            onClick={run}
            disabled={scan.status === 'loading'}
            className="rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 text-sm font-semibold"
          >
            {scan.status === 'loading' ? 'Testando...' : `Testar (${testAllAssets ? 'todos' : `${selectedAssetIds.length} ativo(s)`})`}
          </button>
        </div>
        {error && <div className="text-xs text-rose-400">{error}</div>}
      </div>

      <div ref={resultsRef}>
        <ClassicStrategyResults state={scan} />
      </div>
    </div>
  );
}
