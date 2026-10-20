import { useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { AppEvent, AssetInfo, OrderRecord, Settings } from '@polarium12c/shared';
import { api } from '../api.js';

const STATUS_STYLES: Record<OrderRecord['status'], string> = {
  REQUESTED: 'bg-slate-700 text-slate-200',
  CONFIRMED: 'bg-sky-700 text-sky-100',
  UNKNOWN: 'bg-amber-700 text-amber-100',
  FILLED: 'bg-slate-700 text-slate-200',
  REJECTED: 'bg-rose-700 text-rose-100',
};

const RESULT_STYLES: Record<string, string> = {
  WIN: 'text-emerald-400',
  LOSS: 'text-rose-400',
  DOJI: 'text-slate-400',
};

export function OperationsPage() {
  const { settings } = useOutletContext<{ events: AppEvent[]; settings: Settings | null; refreshHeader: () => Promise<void> }>();
  const [orders, setOrders] = useState<OrderRecord[] | null>(null);
  const [assets, setAssets] = useState<AssetInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      setOrders(await api.getOrders());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    load();
    api.getAssets().then(setAssets).catch(() => {});
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, []);

  // So mostra entradas do modo ATUALMENTE ativo (DEMO ou REAL) — misturar as duas contas na
  // mesma lista confundiria resultado/saldo de uma com a da outra.
  const mode = settings?.mode ?? 'DEMO';
  const filteredOrders = useMemo(() => (orders ?? []).filter((o) => o.mode === mode), [orders, mode]);

  function nameOf(activeId: number): string {
    return assets.find((a) => a.id === activeId)?.name ?? `Ativo ${activeId}`;
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold">Operações</h1>
        <p className="text-slate-400 text-sm">
          Sinais confirmados e resultado de cada ordem enviada — conta{' '}
          <span className={mode === 'REAL' ? 'text-rose-400 font-semibold' : 'text-slate-200 font-semibold'}>{mode}</span>.
        </p>
      </div>

      {error && <div className="rounded-lg border border-rose-800 bg-rose-950/50 p-3 text-sm text-rose-300">{error}</div>}

      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 overflow-x-auto">
        {orders === null ? (
          <div className="text-sm text-slate-500">Carregando...</div>
        ) : filteredOrders.length === 0 ? (
          <div className="text-sm text-slate-500">
            Nenhuma ordem enviada ainda na conta <span className="text-slate-200">{mode}</span>. Ordens só são
            enviadas com todas as verificações de segurança aprovadas.
          </div>
        ) : (
          <table className="w-full text-sm min-w-[720px]">
            <thead>
              <tr className="text-left text-slate-400 border-b border-slate-800">
                <th className="py-2 pr-4">Solicitada em</th>
                <th className="py-2 pr-4">Ativo</th>
                <th className="py-2 pr-4">Direção</th>
                <th className="py-2 pr-4">Gale</th>
                <th className="py-2 pr-4">Valor</th>
                <th className="py-2 pr-4">Status</th>
                <th className="py-2 pr-4">Resultado</th>
                <th className="py-2 pr-4">PnL</th>
              </tr>
            </thead>
            <tbody>
              {filteredOrders.map((o) => (
                <tr key={o.id} className="border-b border-slate-900">
                  <td className="py-1.5 pr-4 text-slate-400 whitespace-nowrap">{new Date(o.requestedAt).toLocaleString('pt-BR')}</td>
                  <td className="py-1.5 pr-4">{nameOf(o.activeId)}</td>
                  <td className="py-1.5 pr-4">{o.direction}</td>
                  <td className="py-1.5 pr-4 text-slate-400">{o.galeLevel > 0 ? `Gale ${o.galeLevel}` : '—'}</td>
                  <td className="py-1.5 pr-4">{o.amount.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}</td>
                  <td className="py-1.5 pr-4">
                    <span className={`text-xs font-medium px-2 py-0.5 rounded ${STATUS_STYLES[o.status]}`}>{o.status}</span>
                  </td>
                  <td className={`py-1.5 pr-4 font-medium ${o.result ? RESULT_STYLES[o.result] : 'text-slate-600'}`}>
                    {o.result ?? '—'}
                  </td>
                  <td className="py-1.5 pr-4">
                    {o.pnl !== undefined ? o.pnl.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '—'}
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
