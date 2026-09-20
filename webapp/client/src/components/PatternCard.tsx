import type { PatternDisplayState, PatternProgress } from '@polarium12c/shared';
import { MiniCandles } from './MiniCandles.js';

interface Props {
  activeId: number;
  label: string;
  progress: PatternProgress | undefined;
}

const STATE_STYLES: Record<PatternDisplayState, { chip: string; ring: string }> = {
  MONITORANDO: { chip: 'bg-slate-700 text-slate-200', ring: 'border-slate-800' },
  ACOMPANHANDO: { chip: 'bg-sky-800 text-sky-100', ring: 'border-slate-800' },
  ATENCAO: { chip: 'bg-amber-700 text-amber-100', ring: 'border-slate-800' },
  PRE_SINAL: { chip: 'bg-rose-800 text-rose-100', ring: 'border-rose-600' },
  CONFIRMADO: { chip: 'bg-emerald-700 text-emerald-100', ring: 'border-emerald-500' },
};

const STATE_LABEL: Record<PatternDisplayState, string> = {
  MONITORANDO: 'MONITORANDO',
  ACOMPANHANDO: 'ACOMPANHANDO',
  ATENCAO: 'ATENÇÃO',
  PRE_SINAL: 'PRÉ-SINAL',
  CONFIRMADO: 'CONFIRMADO',
};

export function PatternCard({ activeId, label, progress }: Props) {
  const matchedLength = progress?.matchedLength ?? 0;
  const state: PatternDisplayState = progress?.state ?? 'MONITORANDO';
  const styles = STATE_STYLES[state];
  const wick11 = progress?.wick11;

  return (
    <div className={`rounded-xl border bg-slate-900 p-4 ${styles.ring}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="font-semibold text-slate-100">{label}</div>
        <span className={`text-xs font-medium px-2 py-1 rounded ${styles.chip}`}>{STATE_LABEL[state]}</span>
      </div>

      <div className="flex items-baseline gap-2 mb-3">
        <span className="text-3xl font-bold">{matchedLength}</span>
        <span className="text-slate-500">/ 12</span>
        <span className="ml-auto text-xs text-slate-500">M1 · ativo {activeId}</span>
      </div>

      <MiniCandles received={progress?.received ?? []} />

      <div className="mt-3 rounded-lg bg-slate-950/60 border border-slate-800 p-3 text-sm">
        <div className="flex justify-between text-slate-400 mb-1">
          <span>11ª vela (pavio inferior)</span>
          {wick11 && wick11.currentPercentage !== null ? (
            <span className={wick11.currentPercentage >= wick11.requiredPercentage ? 'text-emerald-400' : 'text-amber-400'}>
              {(wick11.currentPercentage * 100).toFixed(1)}%
            </span>
          ) : (
            <span>—</span>
          )}
        </div>
        {wick11 && wick11.currentPercentage !== null ? (
          <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
            <div
              className={`h-full ${wick11.currentPercentage >= wick11.requiredPercentage ? 'bg-emerald-500' : 'bg-amber-500'}`}
              style={{ width: `${Math.min(100, wick11.currentPercentage * 100)}%` }}
            />
          </div>
        ) : (
          <div className="text-xs text-slate-500">Aguardando a 11ª vela...</div>
        )}
      </div>
    </div>
  );
}
