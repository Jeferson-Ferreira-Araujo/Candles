import { useEffect, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { AssetInfo, Candle, Settings } from '@polarium12c/shared';
import { api } from '../api.js';
import { AssetBadgePicker } from '../components/AssetBadgePicker.js';
import { CandleChart, type ChartMarker } from '../components/CandleChart.js';
import { findBestStrategy, type BestStrategyResult } from '../lib/bestStrategyFinder.js';
import { useLiveSocket } from '../hooks/useLiveSocket.js';

const DEFAULT_DAYS = 3;

interface OutletCtx {
  settings: Settings | null;
}

function formatPct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

/** Substitui o ultimo candle se for do mesmo periodo (`from` igual — vela em formacao ou recem-fechada), senao acrescenta. */
function mergeCandle(prev: Candle[], candle: Candle): Candle[] {
  const next = [...prev];
  const last = next[next.length - 1];
  if (last && last.from === candle.from) next[next.length - 1] = candle;
  else next.push(candle);
  return next;
}

/**
 * Tela "Gráfico": mostra o candlestick real (histórico + atualização ao vivo quando o ativo
 * escolhido estiver entre os monitorados) de um ativo, com marcadores de entrada/resultado da
 * estratégia que teve a melhor taxa de acerto nos testes (entre as 10 clássicas e o padrão
 * customizado ativo) para esse ativo no período escolhido.
 */
export function ChartPage() {
  const { settings } = useOutletContext<OutletCtx>();
  const [assets, setAssets] = useState<AssetInfo[]>([]);
  const [selectedAssetId, setSelectedAssetId] = useState<number | null>(null);
  const [days, setDays] = useState(DEFAULT_DAYS);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [loadingChart, setLoadingChart] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);
  const [best, setBest] = useState<BestStrategyResult | null | 'loading'>(null);
  const { events, lastCandleUpdate } = useLiveSocket();
  const selectedAssetIdRef = useRef<number | null>(null);
  selectedAssetIdRef.current = selectedAssetId;

  useEffect(() => {
    api.getAssets().then(setAssets).catch(() => {});
  }, []);

  // Vela recem-fechada: se o ativo escolhido estiver entre os monitorados, cada CANDLE_CLOSED
  // desse ativo substitui/acrescenta ao historico ja carregado (sem precisar recarregar tudo).
  useEffect(() => {
    const last = events[0];
    if (!last || last.type !== 'CANDLE_CLOSED' || last.activeId !== selectedAssetIdRef.current) return;
    const candle = (last.payload as { candle?: Candle }).candle;
    if (!candle) return;
    setCandles((prev) => mergeCandle(prev, candle));
  }, [events]);

  // Tick da vela AINDA EM FORMACAO (CANDLE_UPDATED) — e o que faz o grafico "se mexer" em
  // tempo real dentro do minuto, nao so quando uma vela fecha.
  useEffect(() => {
    if (!lastCandleUpdate || lastCandleUpdate.activeId !== selectedAssetIdRef.current) return;
    setCandles((prev) => mergeCandle(prev, lastCandleUpdate.candle));
  }, [lastCandleUpdate]);

  const isLive = lastCandleUpdate !== null && lastCandleUpdate.activeId === selectedAssetId;

  function nameOf(id: number): string {
    return assets.find((a) => a.id === id)?.name ?? `Ativo ${id}`;
  }

  async function loadChart() {
    if (selectedAssetId === null) {
      setChartError('Selecione um ativo antes de carregar o gráfico.');
      return;
    }
    setChartError(null);
    setLoadingChart(true);
    setBest('loading');
    try {
      const data = await api.getCandles(selectedAssetId, days);
      setCandles(data);
    } catch (err) {
      setChartError(err instanceof Error ? err.message : String(err));
      setCandles([]);
    } finally {
      setLoadingChart(false);
    }

    try {
      const result = await findBestStrategy(selectedAssetId, days);
      setBest(result);
    } catch {
      setBest(null);
    }
  }

  const markers: ChartMarker[] = best && best !== 'loading' ? best.markers : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold">Gráfico</h1>
        <p className="text-slate-400 text-sm">
          Candlestick real (histórico + ao vivo) de um ativo, com os sinais da estratégia que teve melhor taxa de
          acerto nos testes para ele.
        </p>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-3">
        <div>
          <div className="text-xs text-slate-500 mb-2">Ativo</div>
          <AssetBadgePicker
            assets={assets}
            value={selectedAssetId !== null ? [selectedAssetId] : []}
            onChange={(ids) => setSelectedAssetId(ids.length > 0 ? ids[ids.length - 1]! : null)}
          />
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
            onClick={loadChart}
            disabled={loadingChart}
            className="rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 text-sm font-semibold"
          >
            {loadingChart ? 'Carregando...' : 'Carregar gráfico'}
          </button>
        </div>
        {chartError && <div className="text-xs text-rose-400">{chartError}</div>}
      </div>

      {best === 'loading' && (
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400 flex items-center gap-2">
          <span className="inline-block h-3 w-3 rounded-full border-2 border-sky-400 border-t-transparent animate-spin" />
          Testando as 10 estratégias clássicas + o padrão ativo pra achar a melhor...
        </div>
      )}
      {best && best !== 'loading' && (
        <div className="rounded-xl border border-emerald-800 bg-emerald-950/30 p-4 flex items-center gap-4 flex-wrap text-sm">
          <div className="font-semibold text-emerald-300">⭐ Melhor estratégia testada: {best.name}</div>
          <span className="text-emerald-400">{best.wins}W</span>
          <span className="text-rose-400">{best.losses}L</span>
          {best.dojis > 0 && <span className="text-slate-400">{best.dojis}D</span>}
          <span className="font-semibold text-white">{formatPct(best.winRate)}</span>
        </div>
      )}
      {best === null && candles.length > 0 && (
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 text-sm text-slate-400">
          Nenhuma estratégia teve ocorrências suficientes nesse período para comparar.
        </div>
      )}

      {candles.length > 0 && (
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <div className="text-sm font-semibold mb-2 flex items-center gap-2">
            <span>
              {selectedAssetId !== null ? nameOf(selectedAssetId) : ''} — {candles.length} velas M1
            </span>
            {isLive ? (
              <span className="flex items-center gap-1 text-xs font-medium text-rose-400">
                <span className="h-2 w-2 rounded-full bg-rose-500 animate-pulse" /> AO VIVO
              </span>
            ) : (
              selectedAssetId !== null &&
              !settings?.selectedActiveIds.includes(selectedAssetId) && (
                <span className="text-xs text-slate-500">
                  (sem atualização ao vivo — adicione este ativo em Configurações para monitorá-lo)
                </span>
              )
            )}
          </div>
          <CandleChart candles={candles} markers={markers} />
        </div>
      )}
    </div>
  );
}
