import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AssetInfo } from '@polarium12c/shared';
import { api } from '../api.js';
import { AssetBadgePicker } from '../components/AssetBadgePicker.js';
import { PatternDiscoveryResults, type DiscoveryRow, type DiscoveryState } from '../components/PatternDiscoveryResults.js';
import { runPatternDiscoveryScan } from '../lib/patternDiscoveryScan.js';

const DEFAULT_DAYS = 7;

/**
 * Tela "Descobrir Padrões": varre o historico de um ou mais ativos (ou todos) procurando
 * sequencias de velas (G/R, minimo 4) que se repetiram pelo menos 10 vezes no mesmo dia.
 * O objetivo e achar candidatos para recriar manualmente na tela de Padrão e testar de verdade
 * (botao "Usar este padrão" leva pra la com as casas ja preenchidas).
 */
export function PatternDiscoveryPage() {
  const navigate = useNavigate();
  const [assets, setAssets] = useState<AssetInfo[]>([]);
  const [testAllAssets, setTestAllAssets] = useState(true);
  const [selectedAssetIds, setSelectedAssetIds] = useState<number[]>([]);
  const [days, setDays] = useState(DEFAULT_DAYS);
  const [discovery, setDiscovery] = useState<DiscoveryState>({ status: 'idle' });
  const [error, setError] = useState<string | null>(null);
  const analysisStartedAt = useRef<number | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.getAssets().then(setAssets).catch(() => {});
  }, []);

  useEffect(() => {
    if (discovery.status !== 'loading') return;
    const interval = setInterval(() => {
      setDiscovery((prev) =>
        prev.status === 'loading' && analysisStartedAt.current !== null
          ? { ...prev, elapsedMs: Date.now() - analysisStartedAt.current }
          : prev
      );
    }, 1000);
    return () => clearInterval(interval);
  }, [discovery.status]);

  async function run() {
    const targetAssets = testAllAssets ? assets : assets.filter((a) => selectedAssetIds.includes(a.id));
    if (targetAssets.length === 0) {
      setError('Selecione pelo menos um ativo (ou marque "Testar todos os ativos") antes de buscar.');
      return;
    }
    setError(null);
    if (targetAssets.length === 0) {
      setDiscovery({ status: 'empty' });
      return;
    }
    analysisStartedAt.current = Date.now();
    const result = await runPatternDiscoveryScan(targetAssets, days, setDiscovery);
    setDiscovery(result);
    resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function usePattern(row: DiscoveryRow) {
    navigate('/pattern', { state: { prefillCandles: row.pattern.sequence } });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold">Descobrir Padrões</h1>
        <p className="text-slate-400 text-sm">
          Vasculha o histórico procurando sequências de velas (mínimo 4) que se repetiram pelo menos 10 vezes no
          mesmo dia. Depois é só usar um resultado pra recriar o padrão e testar de verdade.
        </p>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-3">
        <div className="rounded-lg bg-slate-950/40 border border-slate-800 p-3 space-y-2">
          <div className="text-xs text-slate-500">Ativos a vasculhar</div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={testAllAssets}
              onChange={(e) => setTestAllAssets(e.target.checked)}
              className="accent-sky-500"
            />
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
            disabled={discovery.status === 'loading'}
            className="rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 text-sm font-semibold"
          >
            {discovery.status === 'loading' ? 'Vasculhando...' : `Buscar padrões (${testAllAssets ? 'todos' : `${selectedAssetIds.length} ativo(s)`})`}
          </button>
        </div>
        {error && <div className="text-xs text-rose-400">{error}</div>}
      </div>

      <div ref={resultsRef}>
        <PatternDiscoveryResults state={discovery} onUsePattern={usePattern} />
      </div>
    </div>
  );
}
