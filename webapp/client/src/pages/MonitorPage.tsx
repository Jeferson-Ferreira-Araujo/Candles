import { useEffect, useRef, useState } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import type { AppEvent, AssetInfo, CustomPattern, Settings } from '@polarium12c/shared';
import { entryDirectionOf } from '@polarium12c/shared';
import { PatternCard } from '../components/PatternCard.js';
import { AssetPicker } from '../components/AssetPicker.js';
import { AutoAnalysisCard, type AutoAnalysisState } from '../components/AutoAnalysisCard.js';
import { usePatternProgress } from '../hooks/usePatternProgress.js';
import { runAutoAnalysisScan } from '../lib/autoAnalysis.js';
import { api } from '../api.js';

interface OutletCtx {
  events: AppEvent[];
  settings: Settings | null;
}

const DEFAULT_ANALYSIS_DAYS = 7;

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function describeEvent(e: AppEvent, patternLength: number): string {
  const active = e.activeId !== undefined ? `Ativo ${e.activeId}` : 'Sistema';
  switch (e.type) {
    case 'CANDLE_CLOSED':
      return `${active} — candle fechado`;
    case 'PATTERN_PROGRESS': {
      const progress = (e.payload as any)?.progress;
      return `${active} — ${progress?.matchedLength ?? '?'}/${patternLength} velas`;
    }
    case 'PATTERN_CONFIRMED':
      return `${active} — SINAL CONFIRMADO — entrar ${(e.payload as any)?.direction ?? '?'}`;
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
  const [activePattern, setActivePattern] = useState<CustomPattern | null>(null);
  const [autoAnalysis, setAutoAnalysis] = useState<AutoAnalysisState>({ status: 'idle' });
  const analysisStartedAt = useRef<number | null>(null);

  useEffect(() => {
    api.getAssets().then(setAssets).catch(() => {});
    api.getActivePattern().then(setActivePattern).catch(() => setActivePattern(null));
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
  // mesmo tempo (pool de workers, ver lib/autoAnalysis.ts), nao um por um nem todos de uma
  // vez. `assetsOverride` permite reaproveitar exatamente essa mesma logica pra analisar so
  // um ativo especifico (botao "Rodar só este ativo" no ranking). `daysOverride` permite
  // reconferir um unico ativo numa janela diferente da configurada em Settings.
  async function runAutoAnalysis(assetsOverride?: AssetInfo[], daysOverride?: number) {
    if (!activePattern) {
      setAutoAnalysis({ status: 'error', message: 'Nenhum padrão ativo. Crie e ative um padrão na tela de Padrão.' });
      return;
    }
    const days = daysOverride ?? settings?.analysisDays ?? DEFAULT_ANALYSIS_DAYS;
    const allAssets = assetsOverride ?? (await api.getAssets().catch(() => [] as AssetInfo[]));
    if (allAssets.length === 0) {
      setAutoAnalysis({ status: 'empty' });
      return;
    }

    analysisStartedAt.current = Date.now();
    const entryDirection = entryDirectionOf(activePattern.candles);
    const result = await runAutoAnalysisScan(allAssets, days, activePattern.id, entryDirection, setAutoAnalysis);
    setAutoAnalysis(result);
  }

  const patternLength = activePattern ? activePattern.candles.length - 1 : 0;
  const entryDirection = activePattern ? entryDirectionOf(activePattern.candles) : null;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold">Monitor de Ativos</h1>
        <p className="text-slate-400 text-sm">
          {activePattern
            ? `Acompanhamento em tempo real da formação do padrão "${activePattern.name}" (${patternLength} velas + entrada ${entryDirection} na seguinte). A vela de sinal só confirma com pavio inferior de pelo menos 25%.`
            : 'Nenhum padrão ativo ainda.'}
        </p>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 flex items-center justify-between gap-4 flex-wrap">
        <div>
          <div className="font-semibold">Análise dos últimos {settings?.analysisDays ?? DEFAULT_ANALYSIS_DAYS} dias</div>
          <p className="text-xs text-slate-500 mt-0.5">
            Consolida wins, losses e assertividade por ativo OTC digital, para o padrão ativo. Ajuste o período em{' '}
            <span className="text-slate-300">Configurações</span>.
          </p>
        </div>
        <button
          onClick={() => runAutoAnalysis()}
          disabled={autoAnalysis.status === 'loading' || !activePattern}
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
          disabled={pickedAssetIds.length === 0 || autoAnalysis.status === 'loading' || !activePattern}
          className="rounded-lg bg-sky-700 hover:bg-sky-600 disabled:opacity-50 disabled:cursor-not-allowed px-4 py-2 text-sm font-semibold"
        >
          Analisar selecionados ({pickedAssetIds.length})
        </button>
      </div>

      <AutoAnalysisCard
        state={autoAnalysis}
        onAnalyzeSingleAsset={(asset, days) => runAutoAnalysis([asset], days)}
      />

      {activePattern ? (
        <div className="rounded-xl border border-emerald-800 bg-emerald-950/40 p-4 flex items-center gap-4 sm:gap-6 flex-wrap">
          <div className="flex items-center gap-2 text-emerald-300 font-semibold">
            <span>⚡</span> Estratégia ativa: {activePattern.name}
          </div>
          <div className="text-sm text-slate-300">Padrão:</div>
          <div className="flex gap-1 flex-wrap">
            {activePattern.candles.map((c, i) => (
              <span
                key={i}
                className={`h-6 w-6 rounded-full flex items-center justify-center text-xs font-bold ${
                  c === 'G' ? 'bg-emerald-600' : 'bg-rose-600'
                } ${i === activePattern.candles.length - 1 ? 'ring-2 ring-sky-400' : ''}`}
                title={i === activePattern.candles.length - 1 ? 'Entrada' : undefined}
              >
                {c}
              </span>
            ))}
          </div>
          <div className="sm:ml-auto text-sm text-slate-300">
            Após a {patternLength}ª vela fechar:{' '}
            <span className="font-semibold text-white">Entrar {entryDirection} na {patternLength + 1}ª</span>
          </div>
        </div>
      ) : (
        <div className="rounded-xl border border-amber-800 bg-amber-950/30 p-4 text-sm text-amber-200">
          Nenhum padrão ativo. Crie e ative um padrão na tela{' '}
          <Link to="/pattern" className="underline font-semibold">
            Padrão
          </Link>{' '}
          para começar a monitorar.
        </div>
      )}

      {activeIds.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900 p-6 text-slate-400 text-sm">
          Nenhum ativo selecionado ainda. Vá em <span className="text-slate-200">Configurações</span> para escolher
          quais ativos monitorar.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {activeIds.map((activeId) => (
            <PatternCard
              key={activeId}
              activeId={activeId}
              label={nameOf(activeId)}
              progress={progressByActive.get(activeId)}
              patternLength={patternLength}
            />
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
                <span>{describeEvent(e, patternLength)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
