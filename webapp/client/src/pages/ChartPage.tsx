import { useEffect, useRef, useState } from 'react';
import type { AssetInfo, Candle } from '@polarium12c/shared';
import { api } from '../api.js';
import { AssetBadgePicker } from '../components/AssetBadgePicker.js';
import { CandleChart, type ChartMarker } from '../components/CandleChart.js';
import { findBestStrategy, type BestStrategyResult } from '../lib/bestStrategyFinder.js';
import { useLiveSocket } from '../hooks/useLiveSocket.js';

const DEFAULT_DAYS = 3;

function formatPct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

/**
 * Tela "Gráfico", no estilo das corretoras: escolhe um ativo, carrega o candlestick real
 * (histórico) e o servidor passa a transmitir esse ativo ao vivo (POST /api/chart-stream) —
 * as velas se movem na tela sem precisar que o ativo esteja entre os monitorados nem que haja
 * um padrão/estratégia ativa, é só pra visualização. Também mostra, sobrepostos no gráfico, os
 * sinais da estratégia que teve a melhor taxa de acerto nos testes (entre as 10 clássicas e o
 * padrão customizado ativo) para esse ativo no período escolhido.
 */
export function ChartPage() {
  const [assets, setAssets] = useState<AssetInfo[]>([]);
  const [selectedAssetId, setSelectedAssetId] = useState<number | null>(null);
  const [days, setDays] = useState(DEFAULT_DAYS);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [loadingChart, setLoadingChart] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);
  const [watchingAssetId, setWatchingAssetId] = useState<number | null>(null);
  const [liveCandle, setLiveCandle] = useState<Candle | null>(null);
  const [best, setBest] = useState<BestStrategyResult | null | 'loading'>(null);
  const { events, lastCandleUpdate } = useLiveSocket();
  const watchingAssetIdRef = useRef<number | null>(null);
  watchingAssetIdRef.current = watchingAssetId;

  useEffect(() => {
    api.getAssets().then(setAssets).catch(() => {});
  }, []);

  // Para a transmissao ao sair da tela (sem isso, o servidor continuaria assinado no ultimo
  // ativo escolhido indefinidamente).
  useEffect(() => {
    return () => {
      if (watchingAssetIdRef.current !== null) api.unwatchChartAsset().catch(() => {});
    };
  }, []);

  // Vela recem-fechada do ativo sendo transmitido — vira a "ponta ao vivo" do grafico, sem
  // nunca reconstruir o array historico inteiro (ver CandleChart: so a ultima barra muda).
  useEffect(() => {
    const last = events[0];
    if (!last || last.type !== 'CANDLE_CLOSED' || last.activeId !== watchingAssetIdRef.current) return;
    const candle = (last.payload as { candle?: Candle }).candle;
    if (candle) setLiveCandle(candle);
  }, [events]);

  // Tick da vela AINDA EM FORMACAO (CANDLE_UPDATED) — e o que faz o grafico "se mexer" em
  // tempo real dentro do minuto, nao so quando uma vela fecha.
  useEffect(() => {
    if (!lastCandleUpdate || lastCandleUpdate.activeId !== watchingAssetIdRef.current) return;
    setLiveCandle(lastCandleUpdate.candle);
  }, [lastCandleUpdate]);

  const isLive = lastCandleUpdate !== null && lastCandleUpdate.activeId === watchingAssetId;

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
    setLiveCandle(null);
    try {
      const [data] = await Promise.all([api.getCandles(selectedAssetId, days), api.watchChartAsset(selectedAssetId)]);
      setCandles(data);
      setWatchingAssetId(selectedAssetId);
    } catch (err) {
      setChartError(err instanceof Error ? err.message : String(err));
      setCandles([]);
      setWatchingAssetId(null);
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
          Escolha um ativo e veja o candlestick real se movendo ao vivo, igual na corretora — mais os sinais da
          estratégia que teve melhor taxa de acerto nos testes para ele.
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
            {watchingAssetId !== null &&
              (isLive ? (
                <span className="flex items-center gap-1 text-xs font-medium text-rose-400">
                  <span className="h-2 w-2 rounded-full bg-rose-500 animate-pulse" /> AO VIVO
                </span>
              ) : (
                <span className="flex items-center gap-1 text-xs text-slate-500">
                  <span className="h-2 w-2 rounded-full bg-slate-600" /> aguardando o próximo tick...
                </span>
              ))}
          </div>
          <CandleChart candles={candles} liveCandle={liveCandle} markers={markers} />
        </div>
      )}
    </div>
  );
}
