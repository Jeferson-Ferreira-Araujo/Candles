import { useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import type { AppEvent, AssetInfo, BrokerHistoryPosition, OrderRecord, Settings } from '@polarium12c/shared';
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

const REAL_HISTORY_DAYS_OPTIONS = [1, 7, 30, 90];

export function OperationsPage() {
  const { settings } = useOutletContext<{ events: AppEvent[]; settings: Settings | null; refreshHeader: () => Promise<void> }>();
  const [orders, setOrders] = useState<OrderRecord[] | null>(null);
  const [assets, setAssets] = useState<AssetInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  // "local" = tabela de baixo, lida do NOSSO banco (so existe se o servidor estava de pe no
  // momento exato da entrada). "real" = historico de verdade, puxado DIRETO da corretora via
  // BrokerAdapter.getPositionsHistory — nunca depende do nosso banco, serve de auditoria.
  const [historySource, setHistorySource] = useState<'local' | 'real'>('local');
  const [realHistoryDays, setRealHistoryDays] = useState(7);
  const [realHistory, setRealHistory] = useState<{
    positions: BrokerHistoryPosition[];
    summaryByBalance: Record<string, { wins: number; losses: number; dojis: number; pnl: number }>;
  } | null>(null);
  const [realHistoryError, setRealHistoryError] = useState<string | null>(null);
  const [realHistoryLoading, setRealHistoryLoading] = useState(false);

  async function load() {
    try {
      setOrders(await api.getOrders());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadRealHistory() {
    setRealHistoryLoading(true);
    setRealHistoryError(null);
    try {
      setRealHistory(await api.getRealHistory(realHistoryDays));
    } catch (err) {
      setRealHistoryError(err instanceof Error ? err.message : String(err));
    } finally {
      setRealHistoryLoading(false);
    }
  }

  useEffect(() => {
    load();
    api.getAssets().then(setAssets).catch(() => {});
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, []);

  // So busca o historico real quando a aba estiver aberta (consulta pesada na corretora,
  // pagina 30 em 30 — nao faz sentido rodar em segundo plano sem o usuario estar olhando) e de
  // novo sempre que o periodo (dias) mudar.
  useEffect(() => {
    if (historySource === 'real') loadRealHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [historySource, realHistoryDays]);

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

      <div className="flex gap-1">
        <button
          type="button"
          onClick={() => setHistorySource('local')}
          className={`rounded-lg px-3 py-1.5 text-sm font-medium border ${
            historySource === 'local' ? 'bg-slate-800 border-slate-600 text-white' : 'border-slate-700 text-slate-400 hover:bg-slate-900'
          }`}
        >
          Local (este app)
        </button>
        <button
          type="button"
          onClick={() => setHistorySource('real')}
          title="Puxado direto da corretora — mostra o que de fato aconteceu na conta, mesmo que o app tenha ficado fora do ar"
          className={`rounded-lg px-3 py-1.5 text-sm font-medium border ${
            historySource === 'real' ? 'bg-slate-800 border-slate-600 text-white' : 'border-slate-700 text-slate-400 hover:bg-slate-900'
          }`}
        >
          Real (corretora)
        </button>
      </div>

      {error && <div className="rounded-lg border border-rose-800 bg-rose-950/50 p-3 text-sm text-rose-300">{error}</div>}

      {historySource === 'real' ? (
        <RealHistorySection
          days={realHistoryDays}
          onChangeDays={setRealHistoryDays}
          data={realHistory}
          loading={realHistoryLoading}
          error={realHistoryError}
          nameOf={nameOf}
        />
      ) : (
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
      )}
    </div>
  );
}

const BALANCE_TYPE_LABEL: Record<string, string> = { demo: 'Demo', real: 'Real' };

interface RealHistorySectionProps {
  days: number;
  onChangeDays: (days: number) => void;
  data: { positions: BrokerHistoryPosition[]; summaryByBalance: Record<string, { wins: number; losses: number; dojis: number; pnl: number }> } | null;
  loading: boolean;
  error: string | null;
  nameOf: (activeId: number) => string;
}

/** Formata um valor na moeda informada pela PROPRIA posicao (nunca fixo em BRL — a conta pode
 * ser em USD) — cai pra so mostrar o numero se a moeda vier desconhecida. */
function formatByCurrency(value: number, currency: string | null): string {
  if (!currency) return value.toFixed(2);
  try {
    return value.toLocaleString('pt-BR', { style: 'currency', currency });
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
}

/** Aba "Real (corretora)": historico de posicoes ja fechadas, puxado DIRETO do SDK da Polarium
 * (ver /api/real-history e BrokerAdapter.getPositionsHistory) — nao depende do nosso banco,
 * entao continua mostrando o que de fato aconteceu mesmo que o servidor tenha ficado fora do
 * ar num periodo (foi exatamente o caso encontrado: o registro local ficou praticamente vazio). */
function RealHistorySection({ days, onChangeDays, data, loading, error, nameOf }: RealHistorySectionProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-slate-400">Período:</span>
        {REAL_HISTORY_DAYS_OPTIONS.map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => onChangeDays(d)}
            className={`rounded-md px-2.5 py-1 border ${
              days === d ? 'bg-sky-700 border-sky-500 text-white' : 'border-slate-700 text-slate-400 hover:bg-slate-900'
            }`}
          >
            {d === 1 ? 'Hoje' : `${d}d`}
          </button>
        ))}
      </div>

      {error && <div className="rounded-lg border border-rose-800 bg-rose-950/50 p-3 text-sm text-rose-300">{error}</div>}

      {data && Object.keys(data.summaryByBalance).length > 0 && (
        <div className="flex flex-wrap gap-3">
          {Object.entries(data.summaryByBalance).map(([balanceType, s]) => {
            const total = s.wins + s.losses + s.dojis;
            const winRate = total > 0 ? (s.wins / total) * 100 : 0;
            const currency = data.positions.find((p) => (p.balanceType ?? 'desconhecida') === balanceType)?.currency ?? null;
            return (
              <div key={balanceType} className="rounded-xl border border-slate-800 bg-slate-900 p-4 min-w-[220px]">
                <div className="text-xs text-slate-500 mb-1">Conta {BALANCE_TYPE_LABEL[balanceType] ?? balanceType}</div>
                <div className="flex items-baseline gap-2">
                  <span className="text-lg font-bold text-emerald-400">{s.wins}W</span>
                  <span className="text-lg font-bold text-rose-400">{s.losses}L</span>
                  {s.dojis > 0 && <span className="text-sm text-slate-500">{s.dojis}D</span>}
                  <span className="text-xs text-slate-500">({winRate.toFixed(1)}%)</span>
                </div>
                <div className={`text-sm font-medium mt-1 ${s.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {s.pnl >= 0 ? '+' : ''}
                  {formatByCurrency(s.pnl, currency)}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="rounded-xl border border-slate-800 bg-slate-900 p-4 overflow-x-auto">
        {loading && !data ? (
          <div className="text-sm text-slate-500">Consultando a corretora (pode levar alguns segundos)...</div>
        ) : !data || data.positions.length === 0 ? (
          <div className="text-sm text-slate-500">Nenhuma posição fechada encontrada nesse período.</div>
        ) : (
          <table className="w-full text-sm min-w-[720px]">
            <thead>
              <tr className="text-left text-slate-400 border-b border-slate-800">
                <th className="py-2 pr-4">Fechada em</th>
                <th className="py-2 pr-4">Conta</th>
                <th className="py-2 pr-4">Ativo</th>
                <th className="py-2 pr-4">Direção</th>
                <th className="py-2 pr-4">Valor</th>
                <th className="py-2 pr-4">Resultado</th>
                <th className="py-2 pr-4">PnL</th>
              </tr>
            </thead>
            <tbody>
              {data.positions.map((p) => (
                <tr key={p.externalId} className="border-b border-slate-900">
                  <td className="py-1.5 pr-4 text-slate-400 whitespace-nowrap">
                    {p.closeTime ? new Date(p.closeTime).toLocaleString('pt-BR') : '—'}
                  </td>
                  <td className="py-1.5 pr-4 text-slate-400">{BALANCE_TYPE_LABEL[p.balanceType ?? ''] ?? p.balanceType ?? '—'}</td>
                  <td className="py-1.5 pr-4">{nameOf(p.activeId)}</td>
                  <td className="py-1.5 pr-4">{p.direction ?? '—'}</td>
                  <td className="py-1.5 pr-4">{p.invest !== null ? formatByCurrency(p.invest, p.currency) : '—'}</td>
                  <td className={`py-1.5 pr-4 font-medium ${p.result ? RESULT_STYLES[p.result] : 'text-slate-600'}`}>{p.result ?? '—'}</td>
                  <td className="py-1.5 pr-4">{p.pnlRealized !== null ? formatByCurrency(p.pnlRealized, p.currency) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
