import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppMode, AssetInfo, Candle, ClassicStrategyId, Direction, Settings } from '@polarium12c/shared';
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
 * Tela inicial do app: assim que carrega, varre TODOS os ativos (1 dia) e ja abre direto o
 * ativo+estrategia com melhor taxa de acerto — grafico de candlestick real em tempo real,
 * estilo corretora, com as entradas (win/loss) marcadas e um aviso visual, no grafico e numa
 * faixa, quando o setup acabou de se completar (a vela atual e a entrada). Pensada pra caber
 * numa unica tela: sem lista de ativos pra navegar (so o melhor importa aqui), e com os botoes
 * Comprar/Vender ao LADO do grafico em telas largas (celular deitado incluso), nao embaixo —
 * tudo visivel junto, sem precisar rolar. Os botoes sao so visuais: este app nunca envia ordem
 * nenhuma, so monitora e sugere — quem decide e executa e sempre o usuario.
 */
export function ChartPage() {
  const [assets, setAssets] = useState<AssetInfo[]>([]);
  const [selectedAssetId, setSelectedAssetId] = useState<number | null>(null);
  const [days, setDays] = useState(SCAN_DAYS);
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
  const [resultIndex, setResultIndex] = useState<number | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [orderStatus, setOrderStatus] = useState<'idle' | 'placing' | 'placed' | 'blocked' | 'error'>('idle');
  const [orderMessage, setOrderMessage] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
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
  // 1 dia) e abre direto o par ativo+estrategia que teve a melhor taxa de acerto.
  const runFullScan = useCallback(async () => {
    setScanStatus('scanning');
    try {
      const res = await api.scanAllAssets(SCAN_DAYS);
      setScanInfo({ assetsScanned: res.assetsScanned, tookMs: res.tookMs, bestAssetName: res.best?.assetName });
      setScanRanking(res.top);
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
    api.getAssets().then(setAssets).catch(() => {});
    api.getActivePattern().then((p) => setHasActivePattern(!!p)).catch(() => {});
    api.getSettings().then(setSettings).catch(() => {});
  }, []);

  // Relogio ao vivo — pra entrar manualmente SEM delay/gap, o usuario precisa ver a hora
  // exata, nao so "confiar" no grafico (que pode ter alguns ms de atraso de rede ate chegar).
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
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

  async function updateSettingsQuick(patch: Partial<Settings>) {
    if (!settings) return;
    const prev = settings;
    setSettings({ ...settings, ...patch }); // feedback imediato, otimista
    try {
      const next = await api.saveSettings(patch);
      setSettings(next);
    } catch (err) {
      setSettings(prev); // desfaz se o servidor recusar
      setOrderMessage(err instanceof Error ? err.message : String(err));
      setOrderStatus('error');
    }
  }

  function changeMode(mode: AppMode) {
    if (mode === 'REAL' && settings?.mode !== 'REAL') {
      if (!window.confirm('Mudar para REAL faz o app enviar ordens com DINHEIRO DE VERDADE da sua conta Polarium. Confirma?')) return;
    }
    updateSettingsQuick({ mode });
  }

  function changeGale(level: 0 | 1 | 2) {
    updateSettingsQuick({ galeEnabled: level > 0, galeMaxLevels: level });
  }

  // Envio MANUAL de ordem — clique em Comprar/Vender. SEM confirmacao aqui, nem em REAL: a
  // confirmacao de "dinheiro de verdade" ja acontece uma unica vez, no momento de TROCAR pra
  // REAL (ver changeMode) — depois disso, cada clique precisa sair na hora, sem dialogo, sem
  // delay, pra entrar exatamente no segundo certo. Em OBSERVATION, nem tenta (o SafetyGate do
  // servidor bloquearia de qualquer forma, mas aqui evitamos a chamada e explicamos o motivo).
  async function placeOrder(direction: Direction) {
    if (watchingAssetId === null || !settings) return;
    if (settings.mode === 'OBSERVATION') {
      setOrderStatus('blocked');
      setOrderMessage('Modo OBSERVATION nunca envia ordem — troque pra DEMO ou REAL.');
      return;
    }
    setOrderStatus('placing');
    setOrderMessage(null);
    try {
      const outcome = await api.placeManualOrder(watchingAssetId, direction);
      if (outcome.allowed) {
        setOrderStatus('placed');
        setOrderMessage(`Ordem enviada (${direction === 'CALL' ? 'compra' : 'venda'}).`);
      } else {
        setOrderStatus('blocked');
        setOrderMessage(`Bloqueada: ${outcome.blockedBy.join(', ')}`);
      }
    } catch (err) {
      setOrderStatus('error');
      setOrderMessage(err instanceof Error ? err.message : String(err));
    }
  }

  const markers: ChartMarker[] = best && best !== 'loading' ? [...best.markers] : [];
  // Indicador visual NO PROPRIO GRAFICO de que o setup acabou de se formar — alem da faixa de
  // aviso e dos botoes pulsando, marca a propria vela que esta se formando agora.
  if (pendingSignal && liveCandle) {
    markers.push({
      time: liveCandle.from,
      position: pendingSignal === 'CALL' ? 'belowBar' : 'aboveBar',
      color: '#fbbf24',
      shape: 'circle',
      text: 'ENTRADA',
    });
  }
  const currentPrice = liveCandle?.close ?? candles[candles.length - 1]?.close ?? null;

  // So os marcadores de RESULTADO (win/loss), em ordem cronologica — usado pra "voltar no
  // tempo" navegando ocorrencia por ocorrencia. Depende de `best` (nao do array `markers`
  // acima, que e recriado toda hora) pra so recalcular quando a estrategia/ativo muda de verdade.
  const resultMarkers = useMemo(() => {
    if (!best || best === 'loading') return [];
    return best.markers.filter((m) => m.text === 'WIN' || m.text === 'LOSS').slice().sort((a, b) => a.time - b.time);
  }, [best]);

  // Zera a navegacao sempre que a estrategia/ativo muda — a posicao antiga nao faz sentido
  // pro novo conjunto de ocorrencias.
  useEffect(() => {
    setResultIndex(null);
  }, [best]);

  function goToResultIndex(index: number) {
    if (resultMarkers.length === 0) return;
    const clamped = Math.max(0, Math.min(resultMarkers.length - 1, index));
    setResultIndex(clamped);
    const marker = resultMarkers[clamped]!;
    const centerIdx = candles.findIndex((c) => c.from === marker.time);
    if (centerIdx === -1 || !chartRef.current) return;
    const fromCandle = candles[Math.max(0, centerIdx - 20)]!;
    const toCandle = candles[Math.min(candles.length - 1, centerIdx + 10)]!;
    chartRef.current.setVisibleRange(fromCandle.from, toCandle.to);
  }

  function goPrevResult() {
    goToResultIndex(resultIndex === null ? resultMarkers.length - 1 : resultIndex - 1);
  }

  function goNextResult() {
    goToResultIndex(resultIndex === null ? resultMarkers.length - 1 : resultIndex + 1);
  }

  const currentResult = resultIndex !== null ? resultMarkers[resultIndex] : undefined;

  return (
    <div className="flex flex-col">
      {/* Barra superior: escolha de ativo + estrategia + periodo, compacta, sempre visivel. */}
      <div className="px-3 sm:px-6 py-2 flex flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-950">
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

        {watchingAssetId !== null &&
          (isLive ? (
            <span className="flex items-center gap-1 text-xs font-medium text-rose-400">
              <span className="h-2 w-2 rounded-full bg-rose-500 animate-pulse" /> AO VIVO
            </span>
          ) : (
            <span className="hidden sm:flex items-center gap-1 text-xs text-slate-500">
              <span className="h-2 w-2 rounded-full bg-slate-600" /> aguardando tick...
            </span>
          ))}

        <button
          type="button"
          onClick={() => chartRef.current?.goToRealTime()}
          className="text-xs rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 px-2.5 py-1.5"
        >
          ⏭ agora
        </button>

        {resultMarkers.length > 0 && (
          <div className="flex items-center gap-1 text-xs" title="Navegar pelas entradas passadas (win/loss)">
            <button
              type="button"
              onClick={goPrevResult}
              className="rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 px-2 py-1.5"
            >
              ◀
            </button>
            <span className="text-slate-500 min-w-[64px] text-center">
              {currentResult ? (
                <>
                  <span className={currentResult.text === 'WIN' ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-semibold'}>
                    {currentResult.text}
                  </span>{' '}
                  {resultIndex! + 1}/{resultMarkers.length}
                </>
              ) : (
                `${resultMarkers.length} sinais`
              )}
            </span>
            <button
              type="button"
              onClick={goNextResult}
              className="rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800 px-2 py-1.5"
            >
              ▶
            </button>
          </div>
        )}

        <button
          type="button"
          onClick={runFullScan}
          disabled={scanStatus === 'scanning'}
          title="Testa as 10 estratégias em todos os ativos (1 dia) e abre o melhor par ativo+estratégia"
          className="ml-auto text-xs rounded-lg border border-sky-700 text-sky-300 hover:bg-sky-900/40 disabled:opacity-50 px-2.5 py-1.5 whitespace-nowrap"
        >
          {scanStatus === 'scanning' ? '🔍 Analisando...' : '🔍 Analisar todos'}
        </button>
      </div>

      {/* Linha de status: varredura OU melhor estrategia (nunca as duas, pra poupar altura —
          importante no celular deitado, onde a tela e baixa). */}
      {scanStatus === 'scanning' ? (
        <div className="px-3 sm:px-6 py-1 text-xs text-sky-400 flex items-center gap-2 border-b border-slate-800 bg-sky-950/20">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-sky-400 border-t-transparent animate-spin" />
          Analisando todos os ativos ({SCAN_DAYS} dia)...
        </div>
      ) : best === 'loading' ? (
        <div className="px-3 sm:px-6 py-1 text-xs text-slate-500 flex items-center gap-2 border-b border-slate-800 bg-slate-950">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-sky-400 border-t-transparent animate-spin" />
          Testando estratégia...
        </div>
      ) : (
        best && (
          <div className="px-3 sm:px-6 py-1 flex items-center gap-3 flex-wrap text-xs border-b border-slate-800 bg-emerald-950/20">
            <span className="font-semibold text-emerald-300">⭐ {best.name}</span>
            <span className="text-emerald-400">{best.wins}W</span>
            <span className="text-rose-400">{best.losses}L</span>
            <span className="font-semibold text-white">{formatPct(best.winRate)}</span>
            {scanInfo && (
              <span className="text-slate-600 hidden sm:inline">
                ({scanInfo.assetsScanned} ativos em {formatMs(scanInfo.tookMs)})
              </span>
            )}
            {scanRanking.length > 0 && (
              <button
                type="button"
                onClick={() => setShowRanking((v) => !v)}
                className="text-sky-400 hover:text-sky-300 underline underline-offset-2"
              >
                {showRanking ? 'ocultar ranking' : `ranking (${scanRanking.length})`}
              </button>
            )}
          </div>
        )
      )}
      {scanStatus === 'error' && (
        <div className="px-3 sm:px-6 py-1 text-[11px] text-rose-400 border-b border-slate-800 bg-rose-950/20">
          Falha ao analisar todos os ativos (tente de novo pelo botão).
        </div>
      )}

      {/* Ranking completo da varredura — escondido por padrao, pra caber tudo numa tela so;
          abre sob demanda pra comparar ativo+estrategia antes de decidir. */}
      {showRanking && scanRanking.length > 0 && (
        <div className="border-b border-slate-800 bg-slate-950 max-h-40 overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-slate-900 text-slate-500">
              <tr>
                <th className="text-left font-medium px-3 sm:px-6 py-1">#</th>
                <th className="text-left font-medium py-1">Ativo</th>
                <th className="text-left font-medium py-1">Estratégia</th>
                <th className="text-right font-medium py-1">Acerto</th>
                <th className="text-right font-medium px-3 sm:px-6 py-1">W/L</th>
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
                  <td className="px-3 sm:px-6 py-1 text-slate-500">{i + 1}</td>
                  <td className="py-1 font-medium">{row.assetName}</td>
                  <td className="py-1 text-slate-400">{row.strategyName}</td>
                  <td className="py-1 text-right font-semibold text-emerald-400">{formatPct(row.winRate)}</td>
                  <td className="px-3 sm:px-6 py-1 text-right text-slate-500">
                    {row.wins}/{row.losses}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Aviso de entrada ao vivo: o setup da estrategia escolhida acabou de se completar na
          ultima vela fechada — a vela se formando agora e a entrada (compra ou venda). O
          circulo amarelo "ENTRADA" no grafico (ver markers acima) reforca a mesma coisa
          visualmente em cima da propria vela. */}
      {pendingSignal && (
        <div
          className={`px-3 sm:px-6 py-1.5 flex items-center gap-2 text-sm font-bold border-b animate-pulse ${
            pendingSignal === 'CALL'
              ? 'bg-emerald-600/90 border-emerald-500 text-white'
              : 'bg-rose-600/90 border-rose-500 text-white'
          }`}
        >
          <span className="text-base">🔔</span>
          ENTRADA AGORA — {pendingSignal === 'CALL' ? 'COMPRA (CALL)' : 'VENDA (PUT)'}
        </div>
      )}
      {chartError && (
        <div className="px-3 sm:px-6 py-1 text-xs text-rose-400 border-b border-slate-800 bg-rose-950/20">{chartError}</div>
      )}

      {/* Grafico + botoes Comprar/Vender ao lado (sm+: desktop e celular deitado — a largura
          ja passa de 640px nessa orientacao na maioria dos aparelhos). Em celular em pe, os
          botoes vao pra uma barra embaixo (ver mais abaixo). */}
      <div className="flex">
        <div className="flex-1 min-w-0 h-[60vh] sm:h-[70vh]">
          {candles.length > 0 ? (
            <CandleChart ref={chartRef} candles={candles} liveCandle={liveCandle} markers={markers} fill />
          ) : (
            <div className="h-full flex items-center justify-center text-sm text-slate-500 px-4 text-center">
              {loadingChart || scanStatus === 'scanning' ? 'Carregando...' : 'Escolha um ativo e toque em "Carregar".'}
            </div>
          )}
        </div>

        <div className="hidden sm:flex w-28 md:w-40 shrink-0 border-l border-slate-800 bg-slate-950 flex-col gap-2 p-2 overflow-y-auto">
          <TradePanel
            settings={settings}
            now={now}
            pendingSignal={pendingSignal}
            orderStatus={orderStatus}
            onBuy={() => placeOrder('CALL')}
            onSell={() => placeOrder('PUT')}
            onChangeMode={changeMode}
            onChangeAmount={(amount) => updateSettingsQuick({ entryAmount: amount })}
            onChangeGale={changeGale}
          />
          <div className="pt-1 text-center text-[11px] text-slate-400 space-y-1">
            <div className="truncate font-medium text-slate-200">{nameOf(selectedAssetId) || '—'}</div>
            <div>{currentPrice !== null ? formatPrice(currentPrice) : '—'}</div>
            {best && best !== 'loading' && <div className="text-emerald-400 font-semibold">{formatPct(best.winRate)}</div>}
          </div>
        </div>
      </div>

      {orderMessage && (
        <div
          className={`px-3 sm:px-6 py-1 text-xs border-t ${
            orderStatus === 'placed'
              ? 'text-emerald-400 border-emerald-900 bg-emerald-950/20'
              : 'text-rose-400 border-rose-900 bg-rose-950/20'
          }`}
        >
          {orderMessage}
        </div>
      )}

      {/* Barra inferior — so em celular em pe (sm:hidden), onde nao ha largura pros botoes
          ficarem do lado sem espremer o grafico. */}
      <div className="sm:hidden border-t border-slate-800 bg-slate-950 px-3 py-2.5">
        <TradePanel
          settings={settings}
          now={now}
          pendingSignal={pendingSignal}
          orderStatus={orderStatus}
          horizontal
          onBuy={() => placeOrder('CALL')}
          onSell={() => placeOrder('PUT')}
          onChangeMode={changeMode}
          onChangeAmount={(amount) => updateSettingsQuick({ entryAmount: amount })}
          onChangeGale={changeGale}
        />
        <div className="mt-2 flex items-center gap-4 text-xs text-slate-400">
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

interface TradePanelProps {
  settings: Settings | null;
  now: Date;
  pendingSignal: Direction | null;
  orderStatus: 'idle' | 'placing' | 'placed' | 'blocked' | 'error';
  horizontal?: boolean;
  onBuy: () => void;
  onSell: () => void;
  onChangeMode: (mode: AppMode) => void;
  onChangeAmount: (amount: number) => void;
  onChangeGale: (level: 0 | 1 | 2) => void;
}

/** Relogio + modo (Demo/Real) + valor + Gale + botoes Comprar/Vender — tudo que precisa pra
 * entrar manualmente sem sair da tela do grafico. Usado tanto na coluna lateral (telas
 * largas) quanto na barra inferior (celular em pe), so muda o arranjo (`horizontal`). */
function TradePanel({
  settings,
  now,
  pendingSignal,
  orderStatus,
  horizontal,
  onBuy,
  onSell,
  onChangeMode,
  onChangeAmount,
  onChangeGale,
}: TradePanelProps) {
  const placing = orderStatus === 'placing';
  const timeStr = now.toLocaleTimeString('pt-BR', { hour12: false });
  const secondsLeft = 60 - now.getSeconds(); // segundos ate a vela M1 atual fechar

  return (
    <div className={horizontal ? 'flex items-stretch gap-2' : 'space-y-2'}>
      <div className={horizontal ? 'flex items-center gap-2 text-xs' : 'text-center'}>
        <div className="font-mono text-base font-semibold text-slate-100 tabular-nums">{timeStr}</div>
        <div className={`text-[10px] ${secondsLeft <= 5 ? 'text-amber-400 font-semibold' : 'text-slate-500'}`}>
          {secondsLeft}s p/ fechar
        </div>
      </div>

      <div className={horizontal ? 'flex items-center gap-1' : 'flex gap-1'}>
        <button
          type="button"
          onClick={() => onChangeMode('DEMO')}
          className={`flex-1 rounded-md px-1.5 py-1 text-[10px] font-semibold border ${
            settings?.mode === 'DEMO' ? 'bg-sky-700 border-sky-500 text-white' : 'border-slate-700 text-slate-400'
          }`}
        >
          DEMO
        </button>
        <button
          type="button"
          onClick={() => onChangeMode('REAL')}
          className={`flex-1 rounded-md px-1.5 py-1 text-[10px] font-semibold border ${
            settings?.mode === 'REAL' ? 'bg-rose-700 border-rose-500 text-white' : 'border-slate-700 text-slate-400'
          }`}
        >
          REAL
        </button>
      </div>

      <div className={horizontal ? 'flex items-center gap-1' : 'flex gap-1'}>
        <input
          type="number"
          min={5}
          value={settings?.entryAmount ?? ''}
          onChange={(e) => onChangeAmount(Math.max(5, Number(e.target.value)))}
          className="w-16 bg-slate-900 border border-slate-700 rounded-md px-1.5 py-1 text-xs"
          title="Valor da entrada (R$)"
        />
        <select
          value={settings?.galeEnabled ? settings.galeMaxLevels : 0}
          onChange={(e) => onChangeGale(Number(e.target.value) as 0 | 1 | 2)}
          className="flex-1 bg-slate-900 border border-slate-700 rounded-md px-1 py-1 text-xs"
          title="Gale (reentrada após LOSS)"
        >
          <option value={0}>Sem Gale</option>
          <option value={1}>Gale 1</option>
          <option value={2}>Gale 2</option>
        </select>
      </div>

      <div className={horizontal ? 'flex-1 flex items-center gap-2' : 'space-y-1.5'}>
        <button
          type="button"
          onClick={onSell}
          disabled={placing}
          title={settings?.mode === 'REAL' ? 'Envia ordem com dinheiro de verdade' : 'Envia ordem (conta demo)'}
          className={`flex-1 rounded-lg py-2.5 text-sm font-bold tracking-wide transition-colors disabled:opacity-50 ${
            pendingSignal === 'PUT' ? 'bg-rose-500 ring-2 ring-rose-300 animate-pulse' : 'bg-rose-700/90 hover:bg-rose-600/90'
          }`}
        >
          VENDER
        </button>
        <button
          type="button"
          onClick={onBuy}
          disabled={placing}
          title={settings?.mode === 'REAL' ? 'Envia ordem com dinheiro de verdade' : 'Envia ordem (conta demo)'}
          className={`flex-1 rounded-lg py-2.5 text-sm font-bold tracking-wide transition-colors disabled:opacity-50 ${
            pendingSignal === 'CALL' ? 'bg-emerald-500 ring-2 ring-emerald-300 animate-pulse' : 'bg-emerald-700/90 hover:bg-emerald-600/90'
          }`}
        >
          COMPRAR
        </button>
      </div>
    </div>
  );
}
