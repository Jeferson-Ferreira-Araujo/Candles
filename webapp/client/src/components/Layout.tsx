import { NavLink, Outlet } from 'react-router-dom';
import { useEffect, useState } from 'react';
import type { AppMode, DailyResult, Settings } from '@polarium12c/shared';
import { Header } from './Header.js';
import { api } from '../api.js';
import { useLiveSocket } from '../hooks/useLiveSocket.js';

const NAV_ITEMS = [
  { to: '/', label: 'Monitor', hint: 'Tempo real', icon: '📈' },
  { to: '/backtest', label: 'Validação 30D', hint: 'Histórico da estratégia', icon: '🗓️' },
  { to: '/operations', label: 'Operações', hint: 'Sinais e resultados', icon: '📋' },
  { to: '/settings', label: 'Configurações', hint: 'Robô e risco', icon: '⚙️' },
  { to: '/logs', label: 'Logs', hint: 'Eventos do sistema', icon: '🧾' },
];

export function Layout() {
  const { connected, events } = useLiveSocket();
  const [health, setHealth] = useState<{ mode: AppMode; brokerAdapter: string } | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [dailyResult, setDailyResult] = useState<DailyResult | null>(null);

  async function refresh() {
    const [h, s, d] = await Promise.all([api.health(), api.getSettings(), api.getDailyResult()]);
    setHealth(h as { mode: AppMode; brokerAdapter: string });
    setSettings(s);
    setDailyResult(d);
    try {
      const balances = await api.getBalances();
      setBalance(balances[0]?.amount ?? null);
    } catch {
      setBalance(null);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  // Reflete atualizacoes de settings vindas de outra aba/cliente, e recarrega saldo/
  // resultado do dia quando algo relevante acontece (ordem resolvida, stop atingido).
  useEffect(() => {
    const last = events[0];
    if (!last) return;
    if (['WIN', 'LOSS', 'DOJI', 'STOP_WIN', 'STOP_LOSS'].includes(last.type)) {
      api.getDailyResult().then(setDailyResult).catch(() => {});
    }
  }, [events]);

  async function toggleRobot() {
    if (!settings) return;
    const next = await api.saveSettings({ robotActive: !settings.robotActive });
    setSettings(next);
  }

  return (
    <div className="min-h-screen flex flex-col">
      <Header
        connected={connected}
        brokerAdapter={health?.brokerAdapter ?? 'mock'}
        mode={settings?.mode ?? 'OBSERVATION'}
        robotActive={settings?.robotActive ?? false}
        balance={balance}
        dailyResult={dailyResult}
        settings={settings}
        onToggleRobot={toggleRobot}
      />
      <div className="flex flex-1">
        <nav className="w-56 border-r border-slate-800 bg-slate-950 p-3 space-y-1">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                  isActive ? 'bg-slate-800 text-white' : 'text-slate-400 hover:bg-slate-900 hover:text-slate-200'
                }`
              }
            >
              <span>{item.icon}</span>
              <span>
                <div className="font-medium">{item.label}</div>
                <div className="text-[11px] text-slate-500">{item.hint}</div>
              </span>
            </NavLink>
          ))}
          <div className="pt-4 text-[11px] text-slate-600 px-3">
            12 Candles v0.1.0
            <br />
            Disciplina gera consistência.
          </div>
        </nav>
        <main className="flex-1 p-6 bg-slate-950">
          <Outlet context={{ events, settings, refreshHeader: refresh }} />
        </main>
      </div>
    </div>
  );
}
