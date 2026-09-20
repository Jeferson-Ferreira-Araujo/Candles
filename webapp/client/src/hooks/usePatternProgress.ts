import { useMemo } from 'react';
import type { AppEvent, PatternProgress } from '@polarium12c/shared';

/** Deriva o progresso mais recente de cada ativo a partir do fluxo de eventos do WebSocket. */
export function usePatternProgress(events: AppEvent[]): Map<number, PatternProgress> {
  return useMemo(() => {
    const map = new Map<number, PatternProgress>();
    // events vem do mais novo para o mais velho (unshift no hook do socket) — percorremos
    // do mais velho para o mais novo para que o ultimo grave "vença".
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i]!;
      if (e.activeId === undefined) continue;
      if (e.type === 'PATTERN_PROGRESS' || e.type === 'PATTERN_CONFIRMED' || e.type === 'PATTERN_INVALIDATED') {
        const progress = (e.payload as { progress?: PatternProgress }).progress;
        if (progress) map.set(e.activeId, progress);
      }
    }
    return map;
  }, [events]);
}
