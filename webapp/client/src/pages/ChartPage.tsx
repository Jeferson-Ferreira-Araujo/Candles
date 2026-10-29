import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { AppEvent, AppMode, AssetInfo, Candle, ClassicStrategyId, Direction, Settings } from '@polarium12c/shared';
import { CLASSIC_STRATEGIES } from '@polarium12c/shared';
import { api, type AssetScanRanking, type WatchlistEntry } from '../api.js';
import {
  CandleChart,
  type ActiveOrderLine,
  type CandleChartHandle,
  type ChartMarker,
  type SRLevelLine,
} from '../components/CandleChart.js';
import {
  findBestStrategy,
  runActivePatternStrategy,
  runSingleClassicStrategy,
  type BestStrategyResult,
} from '../lib/bestStrategyFinder.js';
import { useLiveSocket } from '../hooks/useLiveSocket.js';

const SCAN_DAYS = 1; // periodo curto de proposito: a varredura roda em TODOS os ativos, 1 dia ja e pesado

/** Mesma forma do StrategyProgress do servidor (ver server/src/strategies/classicStrategies.ts)
 * — quanto do setup ja esta em pe pra um par ativo+estrategia vigiado. */
interface StrategyProgress {
  stage: number;
  totalStages: number;
  direction: Direction | null;
  readyNow: boolean;
}

interface WatchlistItem {
  activeId: number;
  assetName: string;
  strategyId: ClassicStrategyId;
  strategyName: string;
  progress: StrategyProgress;
  /** epoch ms — so preenchido quando a entrada ESTAVA pronta (readyNow) e deixou de estar no
   * ultimo instante (a vela de confirmacao nao se sustentou). Mostra "Nao entre" por uns
   * segundos em vez de so sumir, ja que o usuario podia estar prestes a clicar. Progresso
   * parcial que se desfaz ANTES de ficar pronto nao usa isso — some direto, sem rastro. */
  cancelledAt?: number;
  /** epoch ms de quando este progresso (este payload exato) chegou do servidor — trava de
   * seguranca contra "falso positivo": se um item ficar marcado como pronto pra entrar por mais
   * tempo do que uma vela M1 deveria durar sem nenhuma atualizacao nova chegando, ele e tratado
   * como obsoleto e some da lista (ver sortedWatchlist) em vez de continuar piscando "Entrada em
   * Ns" indefinidamente — o contador em si e so relogio de parede, nao prova que o sinal ainda
   * vale. */
  receivedAt: number;
}

const WATCHLIST_CANCEL_GRACE_MS = 8000;
// Uma vela M1 dura 60s — da folga de mais uma vela inteira (mais a folga de indexacao do
// servidor) antes de considerar um aviso "pronto pra entrar" obsoleto sem atualizacao nova.
const WATCHLIST_READY_STALE_MS = 130_000;

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

function formatMoney(v: number): string {
  return v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function formatCountdown(seconds: number): string {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Entrada manual que acabou de ser enviada — acompanhada em tempo real no grafico ate resolver. */
interface ActiveOrder {
  signalId: string;
  direction: Direction;
  entryPrice: number;
  /** epoch seconds — quando a vela de entrada (M1) fecha e a ordem deve resolver. */
  expiresAt: number;
  amount: number;
  payoutPercentage: number | null;
  status: 'OPEN' | 'WIN' | 'LOSS' | 'DOJI';
  pnl?: number;
  /** epoch ms (Date.now(), nao epoch seconds como expiresAt) — quando o resultado chegou.
   * So controla quanto tempo a entrada ainda aparece na FAIXA de status (ver visibleBannerOrders);
   * a linha no grafico e o marcador WIN/LOSS continuam ate a proxima entrada, independente disso. */
  resolvedAt?: number;
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
  const [srLevels, setSrLevels] = useState<SRLevelLine[]>([]);
  // Liga/desliga o indicador de Suporte/Resistencia no grafico — igual ao menu de indicadores
  // das corretoras. Ligado por padrao; o usuario pode desligar se achar que estao poluindo a
  // tela num ativo mais volatil.
  const [showSRIndicator, setShowSRIndicator] = useState(true);
  const [loadingChart, setLoadingChart] = useState(false);
  const [chartError, setChartError] = useState<string | null>(null);
  const [watchingAssetId, setWatchingAssetId] = useState<number | null>(null);
  const [liveCandle, setLiveCandle] = useState<Candle | null>(null);
  const [best, setBest] = useState<BestStrategyResult | null | 'loading'>(null);
  const [pendingSignal, setPendingSignal] = useState<Direction | null>(null);
  // epoch seconds (candle.from) de cada vela que ja esta sendo contada no setup da estrategia
  // ABERTA no grafico agora (parcial OU pronto) — pra marcar EXATAMENTE essas velas, nao so
  // avisar com um numero (ver detectStrategyProgress no servidor).
  const [chartSetupCandleTimes, setChartSetupCandleTimes] = useState<number[]>([]);
  const [scanStatus, setScanStatus] = useState<'idle' | 'scanning' | 'done' | 'error'>('idle');
  const [scanInfo, setScanInfo] = useState<{ assetsScanned: number; tookMs: number; bestAssetName?: string } | null>(null);
  const [scanRanking, setScanRanking] = useState<AssetScanRanking[]>([]);
  const [showRanking, setShowRanking] = useState(false);
  const [resultIndex, setResultIndex] = useState<number | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [orderStatus, setOrderStatus] = useState<'idle' | 'placing' | 'placed' | 'blocked' | 'error'>('idle');
  const [orderMessage, setOrderMessage] = useState<string | null>(null);
  // 2+ entradas simultaneas no mesmo ativo sao permitidas (cliques repetidos em Comprar/Vender
  // acumulam, nao substituem) — por isso e uma LISTA, nao uma entrada so.
  const [activeOrders, setActiveOrders] = useState<ActiveOrder[]>([]);
  const [resultToast, setResultToast] = useState<{ status: 'WIN' | 'LOSS' | 'DOJI'; pnl?: number } | null>(null);
  const [now, setNow] = useState(() => new Date());
  // Chave composta `activeId:strategyId` — agora vigiamos TODOS os ativos x TODAS as
  // estrategias, entao o mesmo ativo pode ter mais de um aviso ativo ao mesmo tempo (uma
  // estrategia diferente cada), nao so um por ativo como antes (so top 3).
  const [watchlistProgress, setWatchlistProgress] = useState<Record<string, WatchlistItem>>({});
  const { events, lastCandleUpdate } = useLiveSocket();
  const { refreshHeader } = useOutletContext<{ events: AppEvent[]; settings: Settings | null; refreshHeader: () => Promise<void> }>();
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

  // So da pra checar progresso pra estrategias classicas (o padrao customizado tem seu proprio
  // aviso ao vivo via LiveMonitorService, quando esta entre os ativos monitorados). Busca o
  // progresso INTEIRO (nao so "pronto ou nao") pra poder marcar no grafico quais velas estao
  // sendo contadas na analise agora, parcial ou pronta.
  const checkPendingSignal = useCallback(async (bestOverride?: BestStrategyResult | null, assetIdOverride?: number, daysOverride?: number) => {
    const b = bestOverride !== undefined ? bestOverride : bestRef.current;
    const assetId = assetIdOverride ?? watchingAssetIdRef.current;
    // IMPORTANTE: usa o `days` passado explicitamente (ex.: SCAN_DAYS quando vem de um clique na
    // lista de vigilancia), nunca so `daysRef.current` — antes, um clique na lista podia carregar
    // o grafico com N dias de velas mas consultar o progresso com um `days` DIFERENTE (o que
    // estivesse selecionado no filtro "Dias" da tela, que nao e resetado por esse clique),
    // fazendo o calculo de medias/lookback da estrategia bater com uma janela de velas diferente
    // da exibida — podendo resultar em "nenhuma indicacao" mesmo com a lista mostrando progresso.
    const d = daysOverride ?? daysRef.current;
    if (!b || b === 'loading' || b.kind !== 'classic' || !b.strategyId || assetId === null) {
      setPendingSignal(null);
      setChartSetupCandleTimes([]);
      return;
    }
    try {
      const { progress } = await api.getStrategyProgress(assetId, d, b.strategyId);
      setPendingSignal(progress?.readyNow ? progress.direction : null);
      setChartSetupCandleTimes(progress?.setupCandleTimes ?? []);
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
    setChartSetupCandleTimes([]);
    setActiveOrders([]);
    setSrLevels([]);
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

    // Niveis de Suporte/Resistencia pra desenhar no grafico — so visual (nao decide sinal),
    // entao uma falha aqui nao deve atrapalhar o resto da tela.
    api
      .getSupportResistanceLevels(assetId, d)
      .then((levels) => {
        setSrLevels([
          ...levels.support.map((l) => ({ ...l, type: 'support' as const })),
          ...levels.resistance.map((l) => ({ ...l, type: 'resistance' as const })),
        ]);
      })
      .catch(() => {});

    try {
      const result = await resolveStrategy(assetId, d, mode);
      setBest(result);
      checkPendingSignal(result, assetId, d);
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
    setChartSetupCandleTimes([]);
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

  // Vigia em segundo plano os pares ativo+estrategia do RANKING (ate 20, do 1o ao 20o colocado)
  // — avisa via WebSocket quando "esse mesmo cenario" (o que colocou aquele ativo no ranking)
  // comeca a se formar de novo, mesmo com o usuario olhando outro ativo no grafico. Dedup por
  // ativo+estrategia (o ranking ja vem sem repetir).
  function updateWatchlistFromRanking(top: AssetScanRanking[]) {
    const entries: WatchlistEntry[] = top.slice(0, 20).map((row) => ({
      activeId: row.activeId,
      assetName: row.assetName,
      strategyId: row.strategyId,
      strategyName: row.strategyName,
    }));
    setWatchlistProgress({});
    api.setWatchlist(entries).catch(() => {});
  }

  // Varredura completa: roda as 10 estrategias classicas em TODOS os ativos (periodo curto,
  // 1 dia) e abre direto o par ativo+estrategia que teve a melhor taxa de acerto.
  const runFullScan = useCallback(async () => {
    setScanStatus('scanning');
    try {
      const res = await api.scanAllAssets(SCAN_DAYS);
      setScanInfo({ assetsScanned: res.assetsScanned, tookMs: res.tookMs, bestAssetName: res.best?.assetName });
      setScanRanking(res.top);
      updateWatchlistFromRanking(res.top);
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

  // Varredura de UMA estrategia escolhida: testa SO ela em TODOS os ativos — fluxo "escolhi a
  // estrategia, me diz em quais ativos ela ta valendo a pena e em qual ta se formando AGORA".
  // Abre direto o grafico do melhor resultado e mostra os 5 melhores ativos pra essa estrategia
  // no painel de ranking (mesmo painel usado pela varredura completa).
  const runStrategyScan = useCallback(
    async (strategyId: ClassicStrategyId) => {
      setScanStatus('scanning');
      try {
        const res = await api.scanStrategy(strategyId, SCAN_DAYS);
        setScanInfo({ assetsScanned: res.assetsScanned, tookMs: res.tookMs, bestAssetName: res.best?.assetName });
        setScanRanking(res.top);
        updateWatchlistFromRanking(res.top);
        setShowRanking(true); // abre direto (tabela tem scroll), sem precisar clicar de novo
        setScanStatus('done');
        if (res.best) {
          setDays(SCAN_DAYS);
          loadChartFor(res.best.activeId, strategyId, SCAN_DAYS);
        }
      } catch {
        setScanStatus('error');
      }
    },
    [loadChartFor]
  );

  // Botao "Verificar" da barra superior: o que ele faz depende da estrategia escolhida no
  // seletor — 'auto' reaproveita a varredura completa (10 estrategias), um id especifico dispara
  // a varredura de SO aquela estrategia em todos os ativos, e 'pattern' (padrao customizado) nao
  // tem varredura "todos os ativos" ainda, entao so recarrega o ativo ja selecionado.
  // Verificar: respeita o ativo escolhido (ou "Todos") e a estrategia escolhida (ou
  // "Automatico" = testa todas). 4 combinacoes:
  //  - ativo especifico + estrategia especifica -> carrega direto esse par.
  //  - ativo especifico + automatico -> testa todas as estrategias NESSE ativo, abre a melhor.
  //  - todos os ativos + estrategia especifica -> varre todos os ativos so com essa estrategia.
  //  - todos os ativos + automatico -> varredura completa (como ja era).
  function handleVerify() {
    if (selectedAssetId !== null) {
      loadChartFor(selectedAssetId, strategyMode);
      return;
    }
    if (strategyMode === 'auto') {
      runFullScan();
    } else if (strategyMode === 'pattern') {
      // padrao customizado nao tem varredura "todos os ativos" ainda — precisa escolher um ativo.
      setChartError('Escolha um ativo específico para testar o padrão customizado.');
    } else {
      runStrategyScan(strategyMode);
    }
  }

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
  // ativo escolhido indefinidamente). A watchlist (todos os ativos) e vigilancia do servidor,
  // independente da tela aberta — continua rodando em segundo plano.
  useEffect(() => {
    return () => {
      if (watchingAssetIdRef.current !== null) api.unwatchChartAsset().catch(() => {});
    };
  }, []);

  // Progresso das estrategias do ranking (ate 20 pares ativo+estrategia, vigiados em segundo
  // plano no servidor desde a ultima verificacao) — chega mesmo que o usuario esteja olhando
  // outro ativo no grafico agora. O servidor manda um snapshot inicial assim que a watchlist e
  // definida e dali em diante so quando o progresso de um par MUDA (nunca fica reportando o
  // mesmo estagio a cada fechamento de vela pra nao inundar a tela).
  useEffect(() => {
    const last = events[0];
    if (!last || last.type !== 'WATCHLIST_SIGNAL' || last.activeId === undefined) return;
    const payload = last.payload as unknown as WatchlistEntry & { progress: StrategyProgress | null };
    const key = `${payload.activeId}:${payload.strategyId}`;
    setWatchlistProgress((prev) => {
      const next = { ...prev };
      const prevItem = prev[key];
      // So considera "estava pronta" se realmente estava — nao conta um aviso de cancelamento
      // ja em exibicao como "pronta" de novo.
      const wasReady = prevItem !== undefined && prevItem.progress.readyNow && prevItem.cancelledAt === undefined;
      const base = {
        activeId: payload.activeId,
        assetName: payload.assetName,
        strategyId: payload.strategyId,
        strategyName: payload.strategyName,
      };

      if (payload.progress) {
        const stillReady = payload.progress.readyNow;
        next[key] =
          wasReady && !stillReady
            ? { ...base, progress: payload.progress, cancelledAt: Date.now(), receivedAt: Date.now() } // estava pronta, caiu pra parcial de novo — avisa
            : { ...base, progress: payload.progress, receivedAt: Date.now() };
      } else if (wasReady) {
        // Estava pronta pra entrar e a vela de confirmacao NAO se sustentou — avisa "Nao entre"
        // por um tempo em vez de so sumir (o usuario podia estar prestes a clicar).
        next[key] = { ...base, progress: prevItem!.progress, cancelledAt: Date.now(), receivedAt: Date.now() };
      } else {
        // Progresso parcial que nunca chegou a ficar pronto, e se desfez — some sem deixar rastro.
        delete next[key];
      }
      return next;
    });
  }, [events]);

  // Vela recem-fechada do ativo sendo transmitido — vira a "ponta ao vivo" do grafico, sem
  // nunca reconstruir o array historico inteiro (ver CandleChart: so a ultima barra muda). Toda
  // vez que uma vela fecha tambem e o momento certo de reavaliar se o setup da estrategia
  // acabou de se completar (a vela que vai comecar agora seria a entrada).
  useEffect(() => {
    const last = events[0];
    if (!last || last.type !== 'CANDLE_CLOSED' || last.activeId !== watchingAssetIdRef.current) return;
    const candle = (last.payload as { candle?: Candle }).candle;
    if (candle) setLiveCandle(candle);

    // A vela que acabou de fechar pode ter sido a entrada de uma ocorrencia da estrategia —
    // sem recalcular aqui, o placar W/L e os marcadores do grafico ficam "congelados" no
    // snapshot de quando a tela abriu, mesmo com novos WIN/LOSS acontecendo ao vivo. A mesma
    // folga de 2s usada na vigilancia em segundo plano (WatchlistWatcher) e aplicada aqui —
    // sem ela, o proprio grafico aberto podia, por um instante, "esquecer" a confirmacao que
    // acabou de fechar (corretora ainda indexando a vela no historico) e so recuperar o
    // marcador dela no PROXIMO fechamento.
    const assetId = watchingAssetIdRef.current;
    if (assetId === null) return;
    const timer = setTimeout(() => {
      resolveStrategy(assetId, daysRef.current, strategyModeRef.current)
        .then((result) => {
          setBest(result);
          checkPendingSignal(result, assetId);
        })
        .catch(() => {
          // falha ao recalcular nao deve derrubar a tela — mantem o placar anterior
        });
    }, 2000);
    return () => clearTimeout(timer);
  }, [events, checkPendingSignal]);

  // Resultado de QUALQUER entrada manual em acompanhamento: WIN/LOSS/DOJI chegam via evento
  // (emitidos pelo OrderService quando pollForResolution confirma o fechamento na corretora),
  // casados pelo signalId — pode haver 2+ entradas abertas, cada uma resolve independente.
  useEffect(() => {
    const last = events[0];
    if (!last) return;
    if (last.type !== 'WIN' && last.type !== 'LOSS' && last.type !== 'DOJI') return;
    const payload = last.payload as { signalId?: string; pnl?: number };
    const matched = activeOrders.find((o) => o.signalId === payload.signalId && o.status === 'OPEN');
    if (!matched) return;
    const status = last.type as 'WIN' | 'LOSS' | 'DOJI';
    setActiveOrders((prev) =>
      prev.map((o) => (o.signalId === payload.signalId ? { ...o, status, pnl: payload.pnl, resolvedAt: Date.now() } : o))
    );
    // Aviso igual ao do site oficial: o resultado chega so quando a corretora confirma (poll
    // em segundo plano), entao sem isso o usuario so saberia pelo proprio app da Polarium.
    setResultToast({ status, pnl: payload.pnl });
  }, [events, activeOrders]);

  // Fecha o aviso de resultado sozinho depois de um tempo — nao fica preso na tela.
  useEffect(() => {
    if (!resultToast) return;
    const id = setTimeout(() => setResultToast(null), 6000);
    return () => clearTimeout(id);
  }, [resultToast]);

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
      refreshHeader(); // o cabecalho (saldo/modo) tem seu PROPRIO settings — sem isso ficaria desatualizado ate um F5
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
    // Preco "agora", capturado ANTES do await — e o preco real do clique, nao de quando a
    // resposta do servidor chegar. Expiracao SEMPRE calculada do relogio (proximo fechamento
    // de minuto, M1), nunca de `liveCandle.to` — que pode estar parado na ultima vela que JA
    // fechou (ex.: clique logo apos um CANDLE_CLOSED, antes do proximo tick CANDLE_UPDATED
    // chegar), fazendo a contagem regressiva nascer zerada em vez de contar os ~60s reais.
    const entryPrice = liveCandle?.close ?? candles[candles.length - 1]?.close ?? null;
    const nowSec = Math.floor(Date.now() / 1000);
    const expiresAt = (Math.floor(nowSec / 60) + 1) * 60;
    try {
      const outcome = await api.placeManualOrder(watchingAssetId, direction);
      if (outcome.allowed) {
        setOrderStatus('placed');
        setOrderMessage(`Ordem enviada (${direction === 'CALL' ? 'compra' : 'venda'}).`);
        if (entryPrice !== null) {
          // Acumula — nao substitui — pra permitir 2+ entradas simultaneas no mesmo ativo
          // (cliques repetidos em Comprar/Vender), cada uma com seu proprio acompanhamento.
          setActiveOrders((prev) => [
            ...prev,
            {
              signalId: outcome.signalId,
              direction,
              entryPrice,
              expiresAt,
              amount: outcome.amount,
              payoutPercentage: outcome.payoutPercentage,
              status: 'OPEN',
            },
          ]);
        }
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
  // Marca EXATAMENTE quais velas ja fechadas estao sendo contadas na analise da estrategia
  // aberta agora (parcial ou pronta) — numeradas na ordem (1a, 2a...), pra responder "quais
  // velas estao sendo contadas nessa analise". A ULTIMA contada ganha destaque proprio (ambar,
  // nao azul) pra deixar claro que e a vela final antes da entrada — a proxima vela que abrir
  // (ou a propria, se ja pronta) e onde a entrada acontece.
  chartSetupCandleTimes.forEach((time, idx) => {
    const isLast = idx === chartSetupCandleTimes.length - 1;
    markers.push({
      time,
      position: 'belowBar',
      color: isLast ? '#f59e0b' : '#38bdf8',
      shape: 'circle',
      text: isLast ? `${idx + 1}ª (última)` : `${idx + 1}ª`,
    });
  });
  // Cada entrada manual resolvida marca a sua PROPRIA vela de entrada (M1 = 60s antes da
  // expiracao) com o resultado e o valor — 2+ entradas simultaneas geram 2+ marcadores.
  for (const order of activeOrders) {
    if (order.status === 'OPEN') continue;
    const entryCandleFrom = order.expiresAt - 60;
    const pnlText = order.pnl !== undefined ? ` ${order.pnl >= 0 ? '+' : ''}${formatMoney(order.pnl)}` : '';
    markers.push({
      time: entryCandleFrom,
      position: order.direction === 'CALL' ? 'belowBar' : 'aboveBar',
      color: order.status === 'WIN' ? '#22c55e' : order.status === 'LOSS' ? '#f43f5e' : '#94a3b8',
      shape: order.status === 'WIN' ? 'arrowUp' : order.status === 'LOSS' ? 'arrowDown' : 'circle',
      text: `${order.status}${pnlText}`,
    });
  }
  const currentPrice = liveCandle?.close ?? candles[candles.length - 1]?.close ?? null;

  // Uma linha por entrada, pro grafico desenhar todas simultaneamente.
  const activeOrderLines: ActiveOrderLine[] = activeOrders.map((o) => ({
    id: o.signalId,
    entryPrice: o.entryPrice,
    result: o.status === 'OPEN' ? null : o.status,
  }));

  // A FAIXA de status so mostra entradas em andamento — uma vez resolvida, fica mais uns
  // segundos exibindo o resultado (pra dar tempo de ler) e depois SOME da lista sozinha,
  // mesmo com outras entradas ainda abertas ao lado. A linha no grafico e o marcador WIN/LOSS
  // nao dependem disso — continuam vindo de `activeOrders` inteiro, ate a proxima entrada.
  const BANNER_GRACE_MS = 8000;
  const visibleBannerOrders = activeOrders.filter(
    (o) => o.status === 'OPEN' || (o.resolvedAt !== undefined && now.getTime() - o.resolvedAt < BANNER_GRACE_MS)
  );

  // Totais agregados — "quanto tenho em jogo", "quanto ganho se tudo der WIN", "quanto ja
  // realizei" — somando as entradas ainda visiveis na faixa, nao todo o historico da sessao.
  const openOrders = visibleBannerOrders.filter((o) => o.status === 'OPEN');
  const totalOpenAmount = openOrders.reduce((sum, o) => sum + o.amount, 0);
  const totalEstimatedGain = openOrders.reduce(
    (sum, o) => sum + (o.payoutPercentage !== null ? o.amount * o.payoutPercentage : 0),
    0
  );
  const totalRealizedPnl = visibleBannerOrders
    .filter((o) => o.status !== 'OPEN' && o.pnl !== undefined)
    .reduce((sum, o) => sum + (o.pnl ?? 0), 0);

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

  // Quantos segundos faltam pro minuto atual fechar — a entrada de uma estrategia "pronta"
  // (readyNow) precisa acontecer ANTES disso, ja que e a vela que esta se formando AGORA que
  // serve de entrada. Mesma conta usada pelo acompanhamento de ordem aberta mais abaixo.
  const secondsToMinuteClose = 60 - (Math.floor(now.getTime() / 1000) % 60);

  // Lista de progresso ordenada: prontas pra entrar primeiro, depois por o quao perto estao
  // (stage/totalStages) — exatamente a ordem que ajuda a decidir "em qual eu entro agora".
  // Avisos de cancelamento ("Nao entre") somem sozinhos depois de um tempo de exibicao.
  const sortedWatchlist = Object.entries(watchlistProgress)
    .filter(([, item]) => item.cancelledAt === undefined || now.getTime() - item.cancelledAt < WATCHLIST_CANCEL_GRACE_MS)
    // Trava contra falso positivo: um aviso "pronta pra entrar" sem NENHUMA atualizacao nova ha
    // mais tempo do que uma vela M1 deveria durar e tratado como obsoleto e escondido, mesmo que
    // nenhum evento de cancelamento tenha chegado do servidor pra limpa-lo — o contador exibido
    // ao lado e so relogio de parede, entao sozinho ele NAO prova que o sinal ainda vale.
    .filter(([, item]) => !item.progress.readyNow || now.getTime() - item.receivedAt < WATCHLIST_READY_STALE_MS)
    .sort(([, a], [, b]) => {
      if (a.progress.readyNow !== b.progress.readyNow) return a.progress.readyNow ? -1 : 1;
      return b.progress.stage / b.progress.totalStages - a.progress.stage / a.progress.totalStages;
    });

  return (
    <div className="flex flex-col">
      {/* Notificacao de resultado — igual ao site oficial, aparece flutuando por cima de tudo
          quando a corretora confirma o fechamento da entrada, some sozinha depois de alguns
          segundos. Nao depende do usuario estar olhando a faixa de status pra saber o resultado. */}
      {resultToast && (
        <div className="fixed top-3 left-1/2 -translate-x-1/2 z-50">
          <div
            className={`px-4 py-2.5 rounded-xl shadow-lg border font-bold text-sm flex items-center gap-2 ${
              resultToast.status === 'WIN'
                ? 'bg-emerald-600 border-emerald-400 text-white'
                : resultToast.status === 'LOSS'
                  ? 'bg-rose-600 border-rose-400 text-white'
                  : 'bg-slate-700 border-slate-500 text-white'
            }`}
          >
            <span className="text-base">{resultToast.status === 'WIN' ? '✅' : resultToast.status === 'LOSS' ? '❌' : '➖'}</span>
            {resultToast.status === 'WIN' ? 'GANHOU' : resultToast.status === 'LOSS' ? 'PERDEU' : 'EMPATOU'}
            {resultToast.pnl !== undefined && (
              <span>{resultToast.pnl >= 0 ? `+${formatMoney(resultToast.pnl)}` : formatMoney(resultToast.pnl)}</span>
            )}
          </div>
        </div>
      )}

      {/* Barra superior: Ativo (padrao Todos), Estrategia (padrao Automatico = testa todas),
          Dias (padrao ja vem de hoje) e Verificar — ver handleVerify pra como cada combinacao
          de ativo/estrategia escolhida e interpretada. */}
      <div className="px-3 sm:px-6 py-2 flex flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-950">
        <select
          value={selectedAssetId ?? ''}
          onChange={(e) => setSelectedAssetId(e.target.value === '' ? null : Number(e.target.value))}
          className="bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-sm min-w-[150px]"
          title="Ativo a verificar — Todos testa a estratégia escolhida em todo mundo"
        >
          <option value="">Todos os ativos</option>
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
          className="bg-slate-900 border border-slate-700 rounded-lg px-2.5 py-1.5 text-sm max-w-[180px] font-medium"
          title="Estratégia a verificar — Automático testa todas"
        >
          <option value="auto">⭐ Automático (testa todas)</option>
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
          onClick={handleVerify}
          disabled={scanStatus === 'scanning' || loadingChart}
          title="Verifica o ativo e a estratégia escolhidos (ou todos, se não escolher)"
          className="rounded-lg bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1.5 text-sm font-semibold whitespace-nowrap"
        >
          {scanStatus === 'scanning' || loadingChart ? '🔍 Verificando...' : '🔍 Verificar'}
        </button>

        {/* Indicadores — igual ao menu de indicadores das corretoras: liga/desliga o que
            aparece desenhado em cima do grafico. So Suporte/Resistencia por enquanto. */}
        <details className="relative">
          <summary className="list-none cursor-pointer text-xs text-slate-500 hover:text-slate-300 px-2 py-1.5 select-none">
            📐 indicadores ▾
          </summary>
          <div className="absolute z-20 mt-1 bg-slate-900 border border-slate-700 rounded-lg p-2.5 shadow-lg whitespace-nowrap">
            <label className="flex items-center gap-2 text-xs text-slate-300">
              <input
                type="checkbox"
                checked={showSRIndicator}
                onChange={(e) => setShowSRIndicator(e.target.checked)}
                className="accent-sky-500"
              />
              Suporte / Resistência
            </label>
          </div>
        </details>

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
      </div>


      {/* Linha de status: varredura OU melhor estrategia (nunca as duas, pra poupar altura —
          importante no celular deitado, onde a tela e baixa). */}
      {scanStatus === 'scanning' ? (
        <div className="px-3 sm:px-6 py-1 text-xs text-sky-400 flex items-center gap-2 border-b border-slate-800 bg-sky-950/20">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-sky-400 border-t-transparent animate-spin" />
          Verificando {strategyMode === 'auto' ? 'todas as estratégias' : 'a estratégia'} em todos os ativos ({SCAN_DAYS} dia)...
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
                <th className="text-center font-medium py-1">Agora</th>
                <th className="text-right font-medium py-1">Acerto</th>
                <th className="text-right font-medium px-3 sm:px-6 py-1">Wins/Losses</th>
              </tr>
            </thead>
            <tbody>
              {scanRanking.map((row, i) => (
                <tr
                  key={`${row.activeId}-${row.strategyId}`}
                  onClick={() => applyRanking(row)}
                  className={`cursor-pointer border-t border-slate-900 hover:bg-slate-900 transition-colors ${
                    row.activeId === watchingAssetId && row.strategyId === strategyMode ? 'bg-slate-800' : ''
                  } ${row.pendingDirection ? 'bg-amber-950/30' : ''}`}
                >
                  <td className="px-3 sm:px-6 py-1 text-slate-500">{i + 1}</td>
                  <td className="py-1 font-medium">{row.assetName}</td>
                  <td className="py-1 text-slate-400">{row.strategyName}</td>
                  <td className="py-1 text-center">
                    {row.pendingDirection && (
                      <span
                        className={`inline-flex items-center gap-0.5 font-bold ${
                          row.pendingDirection === 'CALL' ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                        title="Setup se formando agora"
                      >
                        🔔 {row.pendingDirection === 'CALL' ? 'CALL' : 'PUT'}
                      </span>
                    )}
                  </td>
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

      {/* Acompanhamento das entradas manuais enviadas (pode haver 2+ simultaneas no mesmo
          ativo): preco de entrada (mesma linha tracejada do grafico), tempo restante ate a vela
          de expiracao fechar, se esta no lucro/prejuizo AGORA e quanto rende/perde no payout
          vigente — ate o resultado real (WIN/LOSS/DOJI) chegar da corretora. Com 2+ entradas,
          uma linha de totais soma tudo (valor em jogo, ganho/perda potencial, resultado ja
          realizado) alem do detalhe de cada uma. */}
      {visibleBannerOrders.length > 0 && (
        <div className="px-3 sm:px-6 py-1.5 text-xs border-b border-slate-800 bg-slate-900 text-slate-300 space-y-1">
          {visibleBannerOrders.length > 1 && (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-bold pb-1 border-b border-slate-700/60">
              <span>{visibleBannerOrders.length} entradas</span>
              {openOrders.length > 0 && (
                <>
                  <span>
                    Total em jogo: <span className="text-white">{formatMoney(totalOpenAmount)}</span>
                  </span>
                  <span className="text-emerald-400">Ganho total se tudo WIN: +{formatMoney(totalEstimatedGain)}</span>
                  <span className="text-rose-400">Perda total se tudo LOSS: -{formatMoney(totalOpenAmount)}</span>
                </>
              )}
              {visibleBannerOrders.some((o) => o.status !== 'OPEN') && (
                <span className={totalRealizedPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                  Resultado total: {totalRealizedPnl >= 0 ? `+${formatMoney(totalRealizedPnl)}` : formatMoney(totalRealizedPnl)}
                </span>
              )}
            </div>
          )}

          {visibleBannerOrders.map((order) => {
            const secondsToExpiry = order.expiresAt - Math.floor(now.getTime() / 1000);
            const isInProfitNow =
              currentPrice !== null
                ? order.direction === 'CALL'
                  ? currentPrice > order.entryPrice
                  : currentPrice < order.entryPrice
                : null;
            const estimatedGain = order.payoutPercentage !== null ? order.amount * order.payoutPercentage : null;
            return (
              <div key={order.signalId} className="flex flex-wrap items-center gap-x-4 gap-y-1">
                <span className="font-bold">
                  {order.direction === 'CALL' ? '⬆ COMPRA' : '⬇ VENDA'} @ {formatPrice(order.entryPrice)} ({formatMoney(order.amount)})
                </span>

                {order.status === 'OPEN' ? (
                  <>
                    <span>
                      Expira em <span className="font-semibold text-white">{formatCountdown(secondsToExpiry)}</span>
                    </span>
                    {isInProfitNow !== null && (
                      <span className={`font-semibold ${isInProfitNow ? 'text-emerald-400' : 'text-rose-400'}`}>
                        {isInProfitNow ? '▲ No lucro agora' : '▼ No prejuízo agora'}
                      </span>
                    )}
                    <span>
                      Ganho se WIN:{' '}
                      <span className="font-semibold text-emerald-400">
                        {estimatedGain !== null ? `+${formatMoney(estimatedGain)}` : '—'}
                      </span>
                    </span>
                    <span>
                      Perda se LOSS: <span className="font-semibold text-rose-400">-{formatMoney(order.amount)}</span>
                    </span>
                  </>
                ) : (
                  <span
                    className={`font-bold ${
                      order.status === 'WIN' ? 'text-emerald-400' : order.status === 'LOSS' ? 'text-rose-400' : 'text-slate-400'
                    }`}
                  >
                    Resultado: {order.status}
                    {order.pnl !== undefined && (
                      <span className="ml-2">{order.pnl >= 0 ? `+${formatMoney(order.pnl)}` : formatMoney(order.pnl)}</span>
                    )}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Grafico + botoes Comprar/Vender ao lado (sm+: desktop e celular deitado — a largura
          ja passa de 640px nessa orientacao na maioria dos aparelhos). Em celular em pe, os
          botoes vao pra uma barra embaixo (ver mais abaixo). */}
      <div className="flex">
        <div className="flex-1 min-w-0 h-[60vh] sm:h-[70vh]">
          {candles.length > 0 ? (
            <CandleChart
              ref={chartRef}
              candles={candles}
              liveCandle={liveCandle}
              markers={markers}
              activeOrders={activeOrderLines}
              srLevels={showSRIndicator ? srLevels : []}
              fill
            />
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

      {/* Progresso ao vivo das ate 20 estrategias do ranking — abaixo do grafico, SEMPRE
          visivel (mesmo vazia), pra nao parecer que nada esta acontecendo enquanto o usuario
          espera. Ordenada da mais perto de confirmar pra mais longe; a que acabou de confirmar
          (pronta pra entrar na proxima vela) fica em destaque no topo. Clicar troca o grafico
          direto pro ativo+estrategia daquela linha. */}
      <div className="px-3 sm:px-6 py-3 border-t border-slate-800 bg-slate-950">
        <div className="text-xs font-semibold text-slate-400 mb-2">🔔 Estratégias do ranking se formando ao vivo</div>
        {sortedWatchlist.length === 0 ? (
          <div className="text-xs text-slate-600 py-2">
            Nenhuma em formação no momento — vigiando os {scanRanking.length || 0} ativos do ranking em segundo plano.
          </div>
        ) : (
          <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto">
            {sortedWatchlist.map(([key, item]) => {
              const isCancelled = item.cancelledAt !== undefined;
              // 100% = pronta pra entrar na proxima vela. Entre uma confirmacao e a proxima, a
              // barra agora cresce SUAVEMENTE a cada segundo conforme a vela atual vai se
              // formando (em vez de ficar parada ate o fechamento e so entao pular pro proximo
              // degrau) — usa o mesmo relogio de parede do contador de entrada, nunca passa do
              // teto do proximo degrau (90% do caminho ate ele) pra nao sugerir confirmacao que
              // ainda nao aconteceu de verdade.
              const stepSize = 100 / item.progress.totalStages;
              const elapsedFraction = Math.min(1, (60 - secondsToMinuteClose) / 60);
              const percent =
                isCancelled || item.progress.readyNow
                  ? 100
                  : Math.min(100, Math.round(item.progress.stage * stepSize + stepSize * elapsedFraction * 0.9));
              const barColor = isCancelled
                ? 'bg-slate-500'
                : item.progress.readyNow
                  ? item.progress.direction === 'CALL'
                    ? 'bg-emerald-400'
                    : 'bg-rose-400'
                  : 'bg-sky-500';
              // Par ativo+estrategia que esta de fato aberto no grafico agora — pra deixar
              // visivelmente marcado qual linha da lista corresponde a tela que o usuario esta
              // olhando, sem precisar comparar nome de ativo "de cabeca".
              const isActiveChart = item.activeId === watchingAssetId && item.strategyId === strategyMode;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    setStrategyMode(item.strategyId);
                    loadChartFor(item.activeId, item.strategyId, SCAN_DAYS);
                  }}
                  className={`flex flex-col gap-1 rounded-lg border px-3 py-2 text-sm text-left transition-colors ${
                    isActiveChart ? 'ring-2 ring-sky-400' : ''
                  } ${
                    isCancelled
                      ? 'font-bold bg-slate-800/80 border-slate-500 text-slate-300'
                      : item.progress.readyNow
                        ? `font-bold animate-pulse ${
                            item.progress.direction === 'CALL'
                              ? 'bg-emerald-600/20 border-emerald-500 text-emerald-300'
                              : 'bg-rose-600/20 border-rose-500 text-rose-300'
                          }`
                        : 'border-slate-700 text-slate-300 hover:bg-slate-900'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">
                      {isActiveChart && <span className="mr-1.5 text-sky-400" title="Grafico aberto na tela">📍</span>}
                      {item.assetName} <span className="text-slate-500 font-normal">· {item.strategyName}</span>
                      {!isCancelled && item.progress.direction && (
                        <span className={`ml-2 font-semibold ${item.progress.direction === 'CALL' ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {item.progress.direction === 'CALL' ? '⬆ CALL' : '⬇ PUT'}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 whitespace-nowrap">
                      {isCancelled
                        ? '❌ Não entre'
                        : item.progress.readyNow
                          ? `Entrada em ${secondsToMinuteClose}s`
                          : `${item.progress.stage}ª confirmação de ${item.progress.totalStages} · ${percent}%`}
                    </span>
                  </div>
                  <div className="w-full h-1.5 bg-slate-800 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full transition-all duration-500 ${barColor}`} style={{ width: `${percent}%` }} />
                  </div>
                </button>
              );
            })}
          </div>
        )}
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
