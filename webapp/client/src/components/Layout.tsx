import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import type { AppMode, DailyResult, Settings } from '@polarium12c/shared';
import { Header } from './Header.js';
import { api } from '../api.js';
import { useLiveSocket } from '../hooks/useLiveSocket.js';

const NAV_ITEMS = [
  { to: '/', label: 'Gráfico', hint: 'Tempo real', icon: '📊' },
  { to: '/monitor', label: 'Monitor', hint: 'Eventos ao vivo', icon: '📈' },
  { to: '/pattern', label: 'Padrão', hint: 'Editor de padrão', icon: '🕯️' },
  { to: '/pattern-discovery', label: 'Descobrir', hint: 'Identificar padrões', icon: '🔎' },
  { to: '/classic-strategies', label: 'Clássicas', hint: 'Estratégias clássicas', icon: '📐' },
  { to: '/backtest', label: 'Validação 30D', hint: 'Histórico da estratégia', icon: '🗓️' },
  { to: '/operations', label: 'Operações', hint: 'Sinais e resultados', icon: '📋' },
  { to: '/settings', label: 'Configurações', hint: 'Robô e risco', icon: '⚙️' },
  { to: '/logs', label: 'Logs', hint: 'Eventos do sistema', icon: '🧾' },
];

interface LayoutProps {
  requiresLogin: boolean;
  onLoggedOut: () => void;
}

export function Layout({ requiresLogin, onLoggedOut }: LayoutProps) {
  const { connected, events } = useLiveSocket();
  const [health, setHealth] = useState<{ mode: AppMode; brokerAdapter: string } | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [balance, setBalance] = useState<number | null>(null);
  const [dailyResult, setDailyResult] = useState<DailyResult | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const location = useLocation();
  // Prefixo mais longo vence (ex.: "/pattern-discovery" nao pode casar com o item "/pattern"
  // so porque comeca com o mesmo texto).
  const currentNavItem = [...NAV_ITEMS]
    .filter((item) => (item.to === '/' ? location.pathname === '/' : location.pathname.startsWith(item.to)))
    .sort((a, b) => b.to.length - a.to.length)[0] ?? NAV_ITEMS[0]!;

  useEffect(() => {
    setMobileMenuOpen(false);
  }, [location.pathname]);

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

  async function logout() {
    await api.logout();
    onLoggedOut();
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
        showLogout={requiresLogin}
        onLogout={logout}
      />
      <div className="flex flex-1 min-w-0">
        {/* Sidebar completa: so em telas >= sm. Em telas menores, vira barra inferior. */}
        <nav className="hidden sm:block w-56 shrink-0 border-r border-slate-800 bg-slate-950 p-3 space-y-1">
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

        {/* A pagina inicial (grafico) cuida do proprio espacamento pra ficar "tela cheia", igual
            corretora — as outras paginas mantem o padding padrao de sempre. */}
        <main
          className={`flex-1 min-w-0 bg-slate-950 overflow-x-hidden ${
            location.pathname === '/' ? 'pb-16 sm:pb-0' : 'p-4 sm:p-6 pb-20 sm:pb-6'
          }`}
        >
          <Outlet context={{ events, settings, refreshHeader: refresh }} />
        </main>
      </div>

      {/* Barra inferior no celular: com 9 secoes, cada uma virando icone+rotulo espremidos numa
          linha so ficava ilegivel (rotulos grudados uns nos outros) — em vez disso, um botao so
          que mostra a pagina atual e abre a lista completa como um menu deslizante de baixo. */}
      <nav className="sm:hidden fixed bottom-0 inset-x-0 z-30 bg-slate-950 border-t border-slate-800">
        <button
          type="button"
          onClick={() => setMobileMenuOpen(true)}
          className="w-full flex items-center justify-center gap-2 py-3 text-sm text-slate-200 active:bg-slate-900"
        >
          <span className="text-base leading-none">{currentNavItem.icon}</span>
          <span className="font-medium">{currentNavItem.label}</span>
          <span className="text-slate-500 text-xs">▲ menu</span>
        </button>
      </nav>

      {mobileMenuOpen && (
        <div className="sm:hidden fixed inset-0 z-40 flex flex-col justify-end" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label="Fechar menu"
            onClick={() => setMobileMenuOpen(false)}
            className="absolute inset-0 bg-black/60"
          />
          <div className="relative bg-slate-950 border-t border-slate-800 rounded-t-2xl p-3 pb-6 space-y-1 max-h-[75vh] overflow-y-auto">
            <div className="flex justify-center pb-2">
              <div className="h-1 w-10 rounded-full bg-slate-700" />
            </div>
            {NAV_ITEMS.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-lg px-3 py-3 text-sm transition-colors ${
                    isActive ? 'bg-slate-800 text-white' : 'text-slate-300 hover:bg-slate-900'
                  }`
                }
              >
                <span className="text-lg">{item.icon}</span>
                <span>
                  <div className="font-medium">{item.label}</div>
                  <div className="text-[11px] text-slate-500">{item.hint}</div>
                </span>
              </NavLink>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
