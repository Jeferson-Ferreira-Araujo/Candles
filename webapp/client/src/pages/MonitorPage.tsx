import { useEffect, useRef, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { AppEvent, AssetInfo, PatternOccurrence, Settings } from '@polarium12c/shared';
import { ENTRY_DIRECTION, PATTERN_LENGTH, TWELVE_CANDLES_PATTERN } from '@polarium12c/shared';

const LAST_PATTERN_COLOR = TWELVE_CANDLES_PATTERN[PATTERN_LENGTH - 1];
const LAST_COLOR_LABEL = LAST_PATTERN_COLOR === 'G' ? 'verde' : 'vermelha';
import { PatternCard } from '../components/PatternCard.js';
import { AssetPicker } from '../components/AssetPicker.js';
import { AutoAnalysisCard, type AssetTally, type AutoAnalysisState } from '../components/AutoAnalysisCard.js';
import { usePatternProgress } from '../hooks/usePatternProgress.js';
import { api } from '../api.js';

interface OutletCtx {
  events: AppEvent[];
  settings: Settings | null;
}

const DEFAULT_ANALYSIS_DAYS = 7;
// Ativos sao consultados alguns por vez (nao um a um, nao todos de uma vez): sequencial pura
// levava minutos com dezenas de ativos OTC digital (cada um e uma chamada de rede real a
// corretora + gravacao no banco); paralelismo total demais arrisca sobrecarregar a mesma
// conexao WS compartilhada com a Polarium.
const ANALYSIS_CONCURRENCY = 6;

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function describeEvent(e: AppEvent): string {
  const active = e.activeId !== undefined ? `Ativo ${e.activeId}` : 'Sistema';
  switch (e.type) {
    case 'CANDLE_CLOSED':
      return `${active} — candle fechado`;
    case 'PATTERN_PROGRESS': {
      const progress = (e.payload as any)?.progress;
      return `${active} — ${progress?.matchedLength ?? '?'}/${PATTERN_LENGTH} velas`;
    }
    case 'PATTERN_CONFIRMED':
      return `${active} — SINAL CONFIRMADO — entrar ${ENTRY_DIRECTION}`;
    case 'PATTERN_INVALIDATED':
      return `${active} — padrão invalidado (${(e.payload as any)?.reason ?? '?'})`;
    default:
      return `${active} — ${e.type}`;
  }
}

export function MonitorPage() {
  const { events, settings } = useOutletContext<OutletCtx>();
  const progressByActive = usePatternProgress(events);
  const activeIds = settings?.selectedActiveIds ?? [];
  const [assets, setAssets] = useState<AssetInfo[]>([]);
  const [pickedAssetIds, setPickedAssetIds] = useState<number[]>([]);
  const [autoAnalysis, setAutoAnalysis] = useState<AutoAnalysisState>({ status: 'idle' });
  const analysisStartedAt = useRef<number | null>(null);

  useEffect(() => {
    api.getAssets().then(setAssets).catch(() => {});
  }, []);

  // Atualiza "tempo decorrido" a cada segundo enquanto a analise roda, em vez de so quando
  // um ativo termina (uma unica consulta pode levar varios segundos, e sem isso o relogio
  // ficaria parado entre um resultado e outro).
  useEffect(() => {
    if (autoAnalysis.status !== 'loading') return;
    const interval = setInterval(() => {
      setAutoAnalysis((prev) =>
        prev.status === 'loading' && analysisStartedAt.current !== null
          ? { ...prev, elapsedMs: Date.now() - analysisStartedAt.current }
          : prev
      );
    }, 1000);
    return () => clearInterval(interval);
  }, [autoAnalysis.status]);

  function nameOf(id: number): string {
    return assets.find((a) => a.id === id)?.name ?? `Ativo ${id}`;
  }

  // Sob demanda (botao), nao mais automatico no login. Roda o backtest de varios ativos ao
  // mesmo tempo (pool de ANALYSIS_CONCURRENCY workers), nao um por um nem todos de uma vez —
  // sequencial puro levava minutos com dezenas/centenas de ativos OTC digital (cada um e uma
  // chamada de rede real a corretora + gravacao no banco). Erro em um ativo isolado (ex.:
  // ativo invalido) nao aborta os demais, so e contado e ignorado no resultado final.
  //
  // `assetsOverride` permite reaproveitar exatamente essa mesma logica/formato pra analisar
  // so um ativo especifico (botao "Rodar só este ativo" no ranking), sem duplicar o fluxo.
  async function runAutoAnalysis(assetsOverride?: AssetInfo[]) {
    const days = settings?.analysisDays ?? DEFAULT_ANALYSIS_DAYS;
    const allAssets = assetsOverride ?? (await api.getAssets().catch(() => [] as AssetInfo[]));
    if (allAssets.length === 0) {
      setAutoAnalysis({ status: 'empty' });
      return;
    }

    const startedAt = Date.now();
    analysisStartedAt.current = startedAt;
    setAutoAnalysis({
      status: 'loading',
      completed: 0,
      total: allAssets.length,
      currentAssetName: allAssets[0]!.name,
      elapsedMs: 0,
      days,
    });

    const overall: AssetTally = { wins: 0, losses: 0, dojis: 0 };
    const perAsset: Record<number, AssetTally> = {};
    // Guardado para poder mostrar, por ativo, qual foi o padrao de velas de cada ocorrencia
    // (ex.: "quais entradas formaram os 5 wins seguidos"), nao so o placar agregado.
    const occurrencesByAsset: Record<number, PatternOccurrence[]> = {};
    let failedCount = 0;
    let completed = 0;
    // Gale 1 e sempre calculado (nao depende de nenhuma configuracao) para comparar direto
    // com "so 1a entrada" (overall/perAsset acima).
    const reentry = {
      combinedSameDirection: { wins: 0, losses: 0, dojis: 0 } as AssetTally,
      combinedOppositeDirection: { wins: 0, losses: 0, dojis: 0 } as AssetTally,
      consideredLosses: 0,
      missingCandle14: 0,
    };

    let nextIndex = 0;
    async function worker() {
      while (nextIndex < allAssets.length) {
        const asset = allAssets[nextIndex++]!;
        try {
          const { summary, occurrences } = await api.runBacktest([asset.id], days);
          const t = summary.perAsset[asset.id] ?? summary.allOccurrences;
          perAsset[asset.id] = t;
          occurrencesByAsset[asset.id] = occurrences;
          overall.wins += t.wins;
          overall.losses += t.losses;
          overall.dojis += t.dojis;

          reentry.combinedSameDirection.wins += summary.reentry.combinedSameDirection.wins;
          reentry.combinedSameDirection.losses += summary.reentry.combinedSameDirection.losses;
          reentry.combinedSameDirection.dojis += summary.reentry.combinedSameDirection.dojis;
          reentry.combinedOppositeDirection.wins += summary.reentry.combinedOppositeDirection.wins;
          reentry.combinedOppositeDirection.losses += summary.reentry.combinedOppositeDirection.losses;
          reentry.combinedOppositeDirection.dojis += summary.reentry.combinedOppositeDirection.dojis;
          reentry.consideredLosses += summary.reentry.consideredLosses;
          reentry.missingCandle14 += summary.reentry.missingCandle14;
        } catch {
          failedCount++;
        }
        completed++;
        setAutoAnalysis({
          status: 'loading',
          completed,
          total: allAssets.length,
          currentAssetName: asset.name,
          elapsedMs: Date.now() - startedAt,
          days,
        });
      }
    }

    const workerCount = Math.min(ANALYSIS_CONCURRENCY, allAssets.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    setAutoAnalysis({
      status: 'done',
      overall,
      perAsset,
      occurrencesByAsset,
      assets: allAssets,
      failedCount,
      elapsedMs: Date.now() - startedAt,
      days,
      reentry,
    });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold">Monitor de Ativos</h1>
        <p className="text-slate-400 text-sm">
          Acompanhamento em tempo real da formação do padrão ({PATTERN_LENGTH} velas + entrada {ENTRY_DIRECTION} na
          seguinte).
        </p>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <div className="font-semibold">Análise dos últimos {settings?.analysisDays ?? DEFAULT_ANALYSIS_DAYS} dias</div>
          <p className="text-xs text-slate-500 mt-0.5">
            Consolida wins, losses e assertividade por ativo OTC digital. Ajuste o período em{' '}
            <span className="text-slate-300">Configurações</span>.
          </p>
        </div>
        <button
          onClick={() => runAutoAnalysis()}
          disabled={autoAnalysis.status === 'loading'}
          className="rounded-lg bg-sky-700 hover:bg-sky-600 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 text-sm font-semibold shrink-0"
        >
          {autoAnalysis.status === 'loading' ? 'Analisando...' : 'Rodar análise'}
        </button>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 space-y-3">
        <div>
          <div className="font-semibold text-sm">Analisar ativos específicos</div>
          <p className="text-xs text-slate-500 mt-0.5">
            Rode a mesma análise (consolidado + Gale 1) só para os ativos que você escolher, sem esperar todos os
            outros.
          </p>
        </div>
        <AssetPicker value={pickedAssetIds} onChange={setPickedAssetIds} />
        <button
          onClick={() => {
            const picked = assets.filter((a) => pickedAssetIds.includes(a.id));
            if (picked.length > 0) runAutoAnalysis(picked);
          }}
          disabled={pickedAssetIds.length === 0 || autoAnalysis.status === 'loading'}
          className="rounded-lg bg-sky-700 hover:bg-sky-600 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 text-sm font-semibold"
        >
          Analisar selecionados ({pickedAssetIds.length})
        </button>
      </div>

      <AutoAnalysisCard state={autoAnalysis} onAnalyzeSingleAsset={(asset) => runAutoAnalysis([asset])} />

      <div className="rounded-xl border border-emerald-800 bg-emerald-950/40 p-4 flex items-center gap-4 sm:gap-6 flex-wrap">
        <div className="flex items-center gap-2 text-emerald-300 font-semibold">
          <span>⚡</span> Estratégia ativa
        </div>
        <div className="text-sm text-slate-300">Padrão:</div>
        <div className="flex gap-1 flex-wrap">
          {TWELVE_CANDLES_PATTERN.map((c, i) => (
            <span
              key={i}
              className={`h-6 w-6 rounded-full flex items-center justify-center text-xs font-bold ${
                c === 'G' ? 'bg-emerald-600' : 'bg-rose-600'
              }`}
            >
              {c}
            </span>
          ))}
        </div>
        <div className="sm:ml-auto text-sm text-slate-300">
          Após a {PATTERN_LENGTH}ª vela fechar ({LAST_COLOR_LABEL}):{' '}
          <span className="font-semibold text-white">Entrar {ENTRY_DIRECTION} na {PATTERN_LENGTH + 1}ª</span>
        </div>
      </div>

      {activeIds.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-6 text-slate-400 text-sm">
          Nenhum ativo selecionado ainda. Vá em <span className="text-slate-200">Configurações</span> para escolher
          quais ativos monitorar.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {activeIds.map((activeId) => (
            <PatternCard key={activeId} activeId={activeId} label={nameOf(activeId)} progress={progressByActive.get(activeId)} />
          ))}
        </div>
      )}

      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
        <div className="flex items-center gap-2 mb-3">
          <span>🧾</span>
          <span className="font-semibold">Últimos eventos</span>
        </div>
        {events.length === 0 ? (
          <div className="text-sm text-slate-500">Nenhum evento ainda.</div>
        ) : (
          <ul className="space-y-1 text-sm">
            {events.slice(0, 10).map((e) => (
              <li key={e.id} className="flex gap-3 text-slate-300">
                <span className="text-slate-600 w-20 shrink-0">{formatTime(e.createdAt)}</span>
                <span>{describeEvent(e)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
