import { useEffect, useState } from 'react';
import type { AppEvent } from '@polarium12c/shared';
import { api } from '../api.js';

const TYPE_COLORS: Record<string, string> = {
  PATTERN_CONFIRMED: 'text-emerald-400',
  WIN: 'text-emerald-400',
  PATTERN_INVALIDATED: 'text-amber-400',
  LOSS: 'text-rose-400',
  STOP_LOSS: 'text-rose-400',
  KILL_SWITCH: 'text-rose-400',
  CONNECTION_LOST: 'text-rose-400',
};

export function LogsPage() {
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .getEvents(500)
      .then(setEvents)
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">Logs</h1>
        <p className="text-slate-400 text-sm">Eventos do sistema: fechamento de velas, progresso, sinais, ordens e proteções.</p>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
        {loading ? (
          <div className="text-sm text-slate-500">Carregando...</div>
        ) : events.length === 0 ? (
          <div className="text-sm text-slate-500">Nenhum evento registrado ainda.</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-slate-400 border-b border-slate-800">
                <th className="py-2 pr-4">Data/Hora</th>
                <th className="py-2 pr-4">Tipo</th>
                <th className="py-2 pr-4">Ativo</th>
                <th className="py-2 pr-4">Detalhes</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id} className="border-b border-slate-900 align-top">
                  <td className="py-1.5 pr-4 text-slate-500 whitespace-nowrap">{new Date(e.createdAt).toLocaleString('pt-BR')}</td>
                  <td className={`py-1.5 pr-4 font-medium ${TYPE_COLORS[e.type] ?? 'text-slate-200'}`}>{e.type}</td>
                  <td className="py-1.5 pr-4">{e.activeId ?? '—'}</td>
                  <td className="py-1.5 pr-4 text-slate-400 font-mono text-xs max-w-xl truncate" title={JSON.stringify(e.payload)}>
                    {JSON.stringify(e.payload)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
