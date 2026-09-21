import type { PatternDisplayState, PatternProgress } from '@polarium12c/shared';
import { MiniCandles } from './MiniCandles.js';

interface Props {
  activeId: number;
  label: string;
  progress: PatternProgress | undefined;
  patternLength: number;
}

const STATE_STYLES: Record<PatternDisplayState, { chip: string; ring: string }> = {
  MONITORANDO: { chip: 'bg-slate-700 text-slate-200', ring: 'border-slate-800' },
  ACOMPANHANDO: { chip: 'bg-sky-800 text-sky-100', ring: 'border-slate-800' },
  CONFIRMADO: { chip: 'bg-emerald-700 text-emerald-100', ring: 'border-emerald-500' },
};

const STATE_LABEL: Record<PatternDisplayState, string> = {
  MONITORANDO: 'MONITORANDO',
  ACOMPANHANDO: 'ACOMPANHANDO',
  CONFIRMADO: 'CONFIRMADO',
};

export function PatternCard({ activeId, label, progress, patternLength }: Props) {
  const matchedLength = progress?.matchedLength ?? 0;
  const state: PatternDisplayState = progress?.state ?? 'MONITORANDO';
  const styles = STATE_STYLES[state];

  return (
    <div className={`rounded-xl border bg-slate-900 p-4 ${styles.ring}`}>
      <div className="flex items-center justify-between mb-3">
        <div className="font-semibold text-slate-100">{label}</div>
        <span className={`text-xs font-medium px-2 py-1 rounded ${styles.chip}`}>{STATE_LABEL[state]}</span>
      </div>

      <div className="flex items-baseline gap-2 mb-3">
        <span className="text-3xl font-bold">{matchedLength}</span>
        <span className="text-slate-500">/ {patternLength}</span>
        <span className="ml-auto text-xs text-slate-500">M1 · ativo {activeId}</span>
      </div>

      <MiniCandles received={progress?.received ?? []} total={patternLength} />
    </div>
  );
}
