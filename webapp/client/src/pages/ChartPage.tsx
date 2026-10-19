import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AssetInfo, Candle, ClassicStrategyId, Direction } from '@polarium12c/shared';
import { CLASSIC_STRATEGIES } from '@polarium12c/shared';
import { api, type AssetScanRanking } from '../api.js';
import { CandleChart, type CandleChartHandle, type ChartMarker } from '../components/CandleChart.js';
import {
  findBestStrategy,
  runActivePatternStrategy,
  runSingleClassicStrategy,
  type BestStrategyResult,
} from '../lib/bestStrategyFinder.js';
import { useLiveSocket } from '../hooks/useLiveSocket.js';

const DEFAULT_DAYS = 3;
const SCAN_DAYS = 1; // periodo curto de proposito: a varredura roda em TODOS os ativos, 1 dia ja e pesado

/** 'auto' = deixa o app escolher a melhor entre todas; os demais sao escolha manual do usuario. */
type StrategyMode = 'auto' | 'pattern' | ClassicStrategyId;

function formatPct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

function formatPrice(p: number): string {
  return p.toFixed(5);
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

async function resolveStrategy(assetId: number, days: number, mode: StrategyMode): Promise<BestStrategyResult | null> {
  if (mode === 'auto') return findBestStrategy(assetId, days);
  if (mode === 'pattern') return runActivePatternStrategy(assetId, days);
  return runSingleClassicStrategy(assetId, days, mode);
}

/**
 * Tela inicial do app: grafico de candlestick real em tempo real, estilo corretora — escolhe
 * um ativo (pelo seletor ou pela lista lateral), ve as velas se movendo ao vivo, com os sinais
 * da estrategia escolhida sobrepostos (automatica ou manual, ver seletor "Estratégia"). A barra
 * inferior (preco, Comprar/Vender) e so visual, pra ficar parecido com a tela que o usuario ja
 * conhece — este app nunca envia ordem nenhuma (so monitora e sugere, quem decide e executa e
 * sempre o usuario).
 */
export function ChartPage() {
  const [assets, setAssets] = useState<AssetInfo[]>([]);
  const [assetFilter, setAssetFilter] = useState('');
  const [selectedAssetId, setSelectedAssetId] = useState<number | null>(null);
  const [days, setDays] = useState(DEFAULT_DAYS);
  const [strategyMode, setStrategyMode] = useState<StrategyMode>('auto');
  const [hasActivePattern, setHasActivePattern] = useState(false);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [loadingChart, setLoadingChart] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);
  const [watchingAssetId, setWatchingAssetId] = useState<number | null>(null);
  const [liveCandle, setLiveCandle] = useState<Candle | null>(null);
  const [best, setBest] = useState<BestStrategyResult | null | 'loading'>(null);
  const [pendingSignal, setPendingSignal] = useState<Direction | null>(null);
  const [scanStatus, setScanStatus] = useState<'idle' | 'scanning' | 'done' | 'error'>('idle');
  const [scanInfo, setScanInfo] = useState<{ assetsScanned: number; tookMs: number; bestAssetName?: string } | null>(null);
  const [scanRanking, setScanRanking] = useState<AssetScanRanking[]>([]);
  const [showRanking, setShowRanking] = useState(false);
  const { events, lastCandleUpdate } = useLiveSocket();
  const watchingAssetIdRef = useRef<number | null>(null);
  watchingAssetIdRef.current = watchingAssetId;
  const bestRef = useRef<BestStrategyResult | null | 'loading'>(null);
  bestRef.current = best;
  const daysRef = useRef(days);
  daysRef.current = days;
  const strategyModeRef = useRef(strategyMode);
  strategyModeRef.current = strategyMode;
  const scanStartedRef = useRef(false);
  const chartRef = useRef<CandleChartHandle>(null);

  // So da pra checar sinal pendente pra estrategias classicas (o padrao customizado tem seu
  // proprio aviso ao vivo via LiveMonitorService, quando esta entre os ativos monitorados).
  const checkPendingSignal = useCallback(async (bestOverride?: BestStrategyResult | null, assetIdOverride?: number) => {
    const b = bestOverride !== undefined ? bestOverride : bestRef.current;
    const assetId = assetIdOverride ?? watchingAssetIdRef.current;
    if (!b || b === 'loading' || b.kind !== 'classic' || !b.strategyId || assetId === null) {
      setPendingSignal(null);
      return;
    }
    try {
      const { pending } = await api.getPendingSignal(assetId, daysRef.current, b.strategyId);
      setPendingSignal(pending?.direction ?? null);
    } catch {
      // falha ao checar nao deve derrubar a tela — so nao mostra aviso dessa vez
    }
  }, []);

  const loadChartFor = useCallback(async (assetId: number, modeOverride?: StrategyMode, daysOverride?: number) => {
    const mode = modeOverride ?? strategyModeRef.current;
    const d = daysOverride ?? daysRef.current;
    setSelectedAssetId(assetId);
    setChartError(null);
    setLoadingChart(true);
    setBest('loading');
    setLiveCandle(null);
    setPendingSignal(null);
    try {
      const [data] = await Promise.all([api.getCandles(assetId, d), api.watchChartAsset(assetId)]);
      setCandles(data);
      setWatchingAssetId(assetId);
    } catch (err) {
      setChartError(err instanceof Error ? err.message : String(err));
      setCandles([]);
      setWatchingAssetId(null);
    } finally {
      setLoadingChart(false);
    }

    try {
      const result = await resolveStrategy(assetId, d, mode);
      setBest(result);
      checkPendingSignal(result, assetId);
    } catch (err) {
      setBest(null);
      setChartError((prev) => prev ?? (err instanceof Error ? err.message : String(err)));
    }
  }, [checkPendingSignal]);

  // So recalcula estrategia/marcadores pro ativo ja carregado — nao mexe nas velas nem
  // reabre a transmissao (rapido, usado quando o usuario troca so a estrategia no seletor).
  const applyStrategy = useCallback(async (mode: StrategyMode) => {
    const assetId = watchingAssetIdRef.current;
    if (assetId === null) return;
    setBest('loading');
    setPendingSignal(null);
    try {
      const result = await resolveStrategy(assetId, daysRef.current, mode);
      setBest(result);
      checkPendingSignal(result, assetId);
    } catch (err) {
      setBest(null);
      setChartError(err instanceof Error ? err.message : String(err));
    }
  }, [checkPendingSignal]);

  function onStrategyModeChange(mode: StrategyMode) {
    setStrategyMode(mode);
    applyStrategy(mode);
  }

  // Varredura completa: roda as 10 estrategias classicas em TODOS os ativos (periodo curto,
  // 1 dia) e abre direto o par ativo+estrategia que teve a melhor taxa de acerto. Pesado de
  // proposito — avisa no botao/banner se estiver demorando, mas o usuario pode continuar
  // usando a tela normalmente enquanto isso roda em paralelo.
  const runFullScan = useCallback(async () => {
    setScanStatus('scanning');
    try {
      const res = await api.scanAllAssets(SCAN_DAYS);
      setScanInfo({ assetsScanned: res.assetsScanned, tookMs: res.tookMs, bestAssetName: res.best?.assetName });
      setScanRanking(res.top);
      setShowRanking(res.top.length > 0);
      setScanStatus('done');
      if (res.best) {
        setDays(SCAN_DAYS);
        setStrategyMode(res.best.strategyId);
        loadChartFor(res.best.activeId, res.best.strategyId, SCAN_DAYS);
      }
    } catch {
      setScanStatus('error');
    }
  }, [loadChartFor]);

  useEffect(() => {
    api.getAssets().then((list) => {
      setAssets(list);
      setSelectedAssetId((current) => current ?? list[0]?.id ?? null);
    }).catch(() => {});
    api.getActivePattern().then((p) => setHasActivePattern(!!p)).catch(() => {});
  }, []);

  // Analise inicial automatica — so uma vez, assim que a lista de ativos chega.
  useEffect(() => {
    if (assets.length === 0 || scanStartedRef.current) return;
    scanStartedRef.current = true;
    runFullScan();
  }, [assets, runFullScan]);

  // Para a transmissao ao sair da tela (sem isso, o servidor continuaria assinado no ultimo
  // ativo escolhido indefinidamente).
  useEffect(() => {
    return () => {
      if (watchingAssetIdRef.current !== null) api.unwatchChartAsset().catch(() => {});
    };
  }, []);

  // Vela recem-fechada do ativo sendo transmitido — vira a "ponta ao vivo" do grafico, sem
  // nunca reconstruir o array historico inteiro (ver CandleChart: so a ultima barra muda). Toda
  // vez que uma vela fecha tambem e o momento certo de reavaliar se o setup da estrategia
  // acabou de se completar (a vela que vai comecar agora seria a entrada).
  useEffect(() => {
    const last = events[0];
    if (!last || last.type !== 'CANDLE_CLOSED' || last.activeId !== watchingAssetIdRef.current) return;
    const candle = (last.payload as { candle?: Candle }).candle;
    if (candle) setLiveCandle(candle);
    checkPendingSignal();
  }, [events, checkPendingSignal]);

  // Tick da vela AINDA EM FORMACAO (CANDLE_UPDATED) — e o que faz o grafico "se mexer" em
  // tempo real dentro do minuto, nao so quando uma vela fecha.
  useEffect(() => {
    if (!lastCandleUpdate || lastCandleUpdate.activeId !== watchingAssetIdRef.current) return;
    setLiveCandle(lastCandleUpdate.candle);
  }, [lastCandleUpdate]);

  const isLive = lastCandleUpdate !== null && lastCandleUpdate.activeId === watchingAssetId;

  function nameOf(id: number | null): string {
    if (id === null) return '';
    return assets.find((a) => a.id === id)?.name ?? `Ativo ${id}`;
  }

  function loadChart() {
    if (selectedAssetId === null) {
      setChartError('Selecione um ativo antes de carregar o gráfico.');
      return;
    }
    loadChartFor(selectedAssetId);
  }

  function applyRanking(row: AssetScanRanking) {
    setDays(SCAN_DAYS);
    setStrategyMode(row.strategyId);
    loadChartFor(row.activeId, row.strategyId, SCAN_DAYS);
  }

  const markers: ChartMarker[] = best && best !== 'loading' ? best.markers : [];
  const currentPrice = liveCandle?.close ?? candles[candles.length - 1]?.close ?? null;
  const filteredAssets = useMemo(() => {
    const q = assetFilter.trim().toLowerCase();
    if (!q) return assets;
    return assets.filter((a) => a.name.toLowerCase().includes(q));
  }, [assets, assetFilter]);

  return (
    <div className="flex flex-col">
      {/* Barra superior: escolha de ativo + estrategia + periodo, compacta, sempre visivel. */}
      <div className="px-3 sm:px-6 py-2.5 flex flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-950">
        <select
          value={selectedAssetId ?? ''}
          onChange={(e) => setSelectedAssetId(Number(e.target.value))}
          className="bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-sm min-w-[140px]"
        >
          {assets.length === 0 && <option value="">Carregando...</option>}
          {assets.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {a.isOtc ? ' (OTC)' : ''}
            </option>
          ))}
        </select>

        <select
          value={strategyMode}
          onChange={(e) => onStrategyModeChange(e.target.value as StrategyMode)}
          className="bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-sm max-w-[160px]"
          title="Qual estratégia mostrar no gráfico"
        >
          <option value="auto">⭐ Automático (melhor)</option>
          {hasActivePattern && <option value="pattern">Padrão customizado ativo</option>}
          {CLASSIC_STRATEGIES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-1.5 text-xs text-slate-400">
          Dias
          <input
            type="number"
            min={1}
            value={days}
            onChange={(e) => setDays(Math.max(1, Number(e.target.value)))}
            className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1.5 text-sm w-16"
          />
        </label>

        <button
          onClick={loadChart}
          disabled={loadingChart}
          className="rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1.5 text-sm font-semibold"
        >
          {loadingChart ? 'Carregando...' : 'Carregar'}
        </button>

        <div className="flex items-center gap-2 ml-0 sm:ml-2">
          {watchingAssetId !== null &&
            (isLive ? (
              <span className="flex items-center gap-1 text-xs font-medium text-rose-400">
                <span className="h-2 w-2 rounded-full bg-rose-500 animate-pulse" /> AO VIVO
              </span>
            ) : (
              <span className="flex items-center gap-1 text-xs text-slate-500">
                <span className="h-2 w-2 rounded-full bg-slate-600" /> aguardando tick...
              </span>
            ))}
        </div>

        <button
          type="button"
          onClick={() => chartRef.current?.goToRealTime()}
          className="text-xs rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 px-2.5 py-1.5"
        >
          ⏭ Ir para agora
        </button>

        <button
          type="button"
          onClick={runFullScan}
          disabled={scanStatus === 'scanning'}
          title="Testa as 10 estratégias em todos os ativos (1 dia) e abre o melhor par ativo+estratégia"
          className="ml-auto text-xs rounded-lg border border-sky-700 text-sky-300 hover:bg-sky-900/40 disabled:opacity-50 px-2.5 py-1.5 whitespace-nowrap"
        >
          {scanStatus === 'scanning' ? '🔍 Analisando todos os ativos...' : '🔍 Analisar todos os ativos'}
        </button>
      </div>

      {scanStatus === 'scanning' && (
        <div className="px-3 sm:px-6 py-1.5 text-xs text-sky-400 flex items-center gap-2 border-b border-slate-800 bg-sky-950/20">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-sky-400 border-t-transparent animate-spin" />
          Rodando as 10 estratégias em todos os ativos ({SCAN_DAYS} dia) — isso pode demorar um pouco, continue usando a tela normalmente.
        </div>
      )}
      {scanStatus === 'done' && scanInfo && (
        <div className="px-3 sm:px-6 py-1 text-[11px] text-slate-500 border-b border-slate-800 bg-slate-950 flex items-center gap-2 flex-wrap">
          <span>
            Varredura: {scanInfo.assetsScanned} ativos em {formatMs(scanInfo.tookMs)}
            {scanInfo.bestAssetName ? ` — melhor: ${scanInfo.bestAssetName}` : ' — nenhum ativo teve ocorrências suficientes'}.
          </span>
          {scanRanking.length > 0 && (
            <button
              type="button"
              onClick={() => setShowRanking((v) => !v)}
              className="text-sky-400 hover:text-sky-300 underline underline-offset-2"
            >
              {showRanking ? 'ocultar ranking' : `ver ranking completo (${scanRanking.length})`}
            </button>
          )}
        </div>
      )}
      {scanStatus === 'error' && (
        <div className="px-3 sm:px-6 py-1 text-[11px] text-rose-400 border-b border-slate-800 bg-rose-950/20">
          Falha ao analisar todos os ativos (tente de novo pelo botão).
        </div>
      )}

      {/* Ranking completo da varredura: ativo + estrategia + taxa de acerto, pra comparar e
          escolher manualmente em vez de so aceitar a sugestao automatica. */}
      {showRanking && scanRanking.length > 0 && (
        <div className="border-b border-slate-800 bg-slate-950 max-h-56 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-900 text-slate-500">
              <tr>
                <th className="text-left font-medium px-3 sm:px-6 py-1.5">#</th>
                <th className="text-left font-medium py-1.5">Ativo</th>
                <th className="text-left font-medium py-1.5">Estratégia</th>
                <th className="text-right font-medium py-1.5">Acerto</th>
                <th className="text-right font-medium px-3 sm:px-6 py-1.5">W/L</th>
              </tr>
            </thead>
            <tbody>
              {scanRanking.map((row, i) => (
                <tr
                  key={`${row.activeId}-${row.strategyId}`}
                  onClick={() => applyRanking(row)}
                  className={`cursor-pointer border-t border-slate-900 hover:bg-slate-900 transition-colors ${
                    row.activeId === watchingAssetId && row.strategyId === strategyMode ? 'bg-slate-800' : ''
                  }`}
                >
                  <td className="px-3 sm:px-6 py-1.5 text-slate-500">{i + 1}</td>
                  <td className="py-1.5 font-medium">{row.assetName}</td>
                  <td className="py-1.5 text-slate-400">{row.strategyName}</td>
                  <td className="py-1.5 text-right font-semibold text-emerald-400">{formatPct(row.winRate)}</td>
                  <td className="px-3 sm:px-6 py-1.5 text-right text-slate-500">
                    {row.wins}/{row.losses}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Faixa da melhor estrategia — so aparece quando ha algo pra mostrar, pra nao ocupar
          espaco a toa. */}
      {best === 'loading' && (
        <div className="px-3 sm:px-6 py-1.5 text-xs text-slate-500 flex items-center gap-2 border-b border-slate-800 bg-slate-950">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-sky-400 border-t-transparent animate-spin" />
          Testando estratégia...
        </div>
      )}
      {best && best !== 'loading' && (
        <div className="px-3 sm:px-6 py-1.5 flex items-center gap-3 flex-wrap text-xs border-b border-slate-800 bg-emerald-950/20">
          <span className="font-semibold text-emerald-300">⭐ {best.name}</span>
          <span className="text-emerald-400">{best.wins}W</span>
          <span className="text-rose-400">{best.losses}L</span>
          <span className="font-semibold text-white">{formatPct(best.winRate)}</span>
          <span className="text-slate-500 ml-auto hidden sm:flex items-center gap-3">
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-emerald-500" /> acerto
            </span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-rose-500" /> erro
            </span>
          </span>
        </div>
      )}

      {/* Aviso de entrada ao vivo: o setup da estrategia escolhida acabou de se completar na
          ultima vela fechada — a vela se formando agora e a entrada (compra ou venda). */}
      {pendingSignal && (
        <div
          className={`px-3 sm:px-6 py-2 flex items-center gap-2 text-sm font-bold border-b animate-pulse ${
            pendingSignal === 'CALL'
              ? 'bg-emerald-600/90 border-emerald-500 text-white'
              : 'bg-rose-600/90 border-rose-500 text-white'
          }`}
        >
          <span className="text-base">🔔</span>
          ENTRADA AGORA — {pendingSignal === 'CALL' ? 'COMPRA (CALL)' : 'VENDA (PUT)'}: a vela atual é a entrada
        </div>
      )}
      {chartError && (
        <div className="px-3 sm:px-6 py-1.5 text-xs text-rose-400 border-b border-slate-800 bg-rose-950/20">{chartError}</div>
      )}

      {/* Grafico + lista lateral de ativos, igual corretora. */}
      <div className="flex">
        <div className="flex-1 min-w-0 h-[58vh] sm:h-[66vh]">
          {candles.length > 0 ? (
            <CandleChart ref={chartRef} candles={candles} liveCandle={liveCandle} markers={markers} fill />
          ) : (
            <div className="h-full flex items-center justify-center text-sm text-slate-500 px-4 text-center">
              {loadingChart ? 'Carregando velas...' : 'Escolha um ativo e toque em "Carregar" para ver o gráfico.'}
            </div>
          )}
        </div>

        <div className="w-[88px] sm:w-44 shrink-0 border-l border-slate-800 bg-slate-950 flex flex-col">
          <div className="hidden sm:block p-2 border-b border-slate-800">
            <input
              value={assetFilter}
              onChange={(e) => setAssetFilter(e.target.value)}
              placeholder="Filtrar..."
              className="w-full bg-slate-900 border border-slate-700 rounded-md px-2 py-1 text-xs"
            />
          </div>
          <div className="flex-1 overflow-y-auto">
            {filteredAssets.map((a) => (
              <button
                key={a.id}
                type="button"
                onClick={() => loadChartFor(a.id)}
                className={`w-full text-left px-2 py-2 border-b border-slate-900 transition-colors ${
                  a.id === watchingAssetId ? 'bg-slate-800' : 'hover:bg-slate-900'
                }`}
                title={a.name}
              >
                <div className="text-[11px] sm:text-xs font-medium truncate">{a.name}</div>
                {a.isOtc && <div className="text-[9px] sm:text-[10px] text-amber-500">OTC</div>}
              </button>
            ))}
            {assets.length > 0 && filteredAssets.length === 0 && (
              <div className="p-2 text-[10px] text-slate-500">Nenhum ativo.</div>
            )}
          </div>
        </div>
      </div>

      {/* Barra inferior estilo corretora — so visual: este app nunca envia ordem nenhuma, os
          botoes Comprar/Vender nao fazem nada ao clicar. */}
      <div className="border-t border-slate-800 bg-slate-950 px-3 sm:px-6 py-3 flex items-center gap-3 sm:gap-6 flex-wrap">
        <button
          type="button"
          title="Este app apenas monitora — não envia ordens."
          className={`order-2 sm:order-1 flex-1 sm:flex-none rounded-lg px-4 sm:px-6 py-2.5 text-sm font-bold tracking-wide transition-colors ${
            pendingSignal === 'PUT' ? 'bg-rose-500 ring-2 ring-rose-300 animate-pulse' : 'bg-rose-700/90 hover:bg-rose-600/90'
          }`}
        >
          VENDER
        </button>
        <button
          type="button"
          title="Este app apenas monitora — não envia ordens."
          className={`order-3 sm:order-2 flex-1 sm:flex-none rounded-lg px-4 sm:px-6 py-2.5 text-sm font-bold tracking-wide transition-colors ${
            pendingSignal === 'CALL' ? 'bg-emerald-500 ring-2 ring-emerald-300 animate-pulse' : 'bg-emerald-700/90 hover:bg-emerald-600/90'
          }`}
        >
          COMPRAR
        </button>

        <div className="order-1 sm:order-3 w-full sm:w-auto flex items-center gap-4 text-xs text-slate-400 sm:ml-4">
          <div>
            <div className="text-slate-500">Ativo</div>
            <div className="text-slate-200 font-medium">{nameOf(selectedAssetId) || '—'}</div>
          </div>
          <div>
            <div className="text-slate-500">Preço</div>
            <div className="text-slate-200 font-medium">{currentPrice !== null ? formatPrice(currentPrice) : '—'}</div>
          </div>
          {best && best !== 'loading' && (
            <div>
              <div className="text-slate-500">Taxa de acerto</div>
              <div className="text-emerald-400 font-semibold">{formatPct(best.winRate)}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
