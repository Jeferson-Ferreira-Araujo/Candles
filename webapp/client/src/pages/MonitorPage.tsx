import { useEffect, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { AppEvent, AssetInfo, Settings } from '@polarium12c/shared';
import { TWELVE_CANDLES_PATTERN } from '@polarium12c/shared';
import type { AutoAnalysisState } from '../App.js';
import { PatternCard } from '../components/PatternCard.js';
import { AutoAnalysisCard } from '../components/AutoAnalysisCard.js';
import { usePatternProgress } from '../hooks/usePatternProgress.js';
import { api } from '../api.js';

interface OutletCtx {
  events: AppEvent[];
  settings: Settings | null;
  autoAnalysis: AutoAnalysisState;
}

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
      return `${active} — ${progress?.matchedLength ?? '?'}/12 velas`;
    }
    case 'PATTERN_CONFIRMED':
      return `${active} — SINAL 12 CANDLES CONFIRMADO`;
    case 'PATTERN_INVALIDATED':
      return `${active} — padrão invalidado (${(e.payload as any)?.reason ?? '?'})`;
    default:
      return `${active} — ${e.type}`;
  }
}

export function MonitorPage() {
  const { events, settings, autoAnalysis } = useOutletContext<OutletCtx>();
  const progressByActive = usePatternProgress(events);
  const activeIds = settings?.selectedActiveIds ?? [];
  const [assets, setAssets] = useState<AssetInfo[]>([]);

  useEffect(() => {
    api.getAssets().then(setAssets).catch(() => {});
  }, []);

  function nameOf(id: number): string {
    return assets.find((a) => a.id === id)?.name ?? `Ativo ${id}`;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold">Monitor de Ativos</h1>
        <p className="text-slate-400 text-sm">Acompanhamento em tempo real da formação da estratégia 12 Candles.</p>
      </div>

      <AutoAnalysisCard state={autoAnalysis} />

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
          Após a 12ª vela fechar: <span className="font-semibold text-white">Entrar CALL na 13ª</span>
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
