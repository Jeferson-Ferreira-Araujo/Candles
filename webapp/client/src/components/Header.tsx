import { useState } from 'react';
import type { AppMode, DailyResult, Settings } from '@polarium12c/shared';

interface Props {
  connected: boolean;
  brokerAdapter: string;
  mode: AppMode;
  balance: number | null;
  dailyResult: DailyResult | null;
  settings: Settings | null;
  onChangeMode: (mode: AppMode) => void;
  showLogout: boolean;
  onLogout: () => void;
}

const MODE_PILL_STYLES: Record<AppMode, string> = {
  OBSERVATION: 'bg-slate-700 text-slate-100',
  DEMO: 'bg-sky-700 text-sky-100',
  REAL: 'bg-rose-700 text-rose-100',
};

/** Cabecalho compacto (mockup "Painel"): logo+titulo, status de conexao e o modo (DEMO/REAL)
 * como um dropdown — substituiu os antigos rotulos "Modo"/"Robô" + botao "Ligar robô" (o robo
 * agora tem seu proprio indicador dentro da tela do Painel, ver ChartPage). Embaixo, os 3
 * numeros do dia (saldo, resultado, operações). */
export function Header({ connected, brokerAdapter, mode, balance, dailyResult, settings, onChangeMode, showLogout, onLogout }: Props) {
  const [modeMenuOpen, setModeMenuOpen] = useState(false);
  const pnl = dailyResult?.pnl ?? 0;
  const pnlColor = pnl > 0 ? 'text-emerald-400' : pnl < 0 ? 'text-rose-400' : 'text-slate-300';

  return (
    <header className="border-b border-slate-800 bg-slate-950 px-3 py-2.5 sm:px-6">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-lg shrink-0">🕯️</span>
          <div className="min-w-0">
            <div className="font-bold text-base leading-none truncate">12 CANDLES</div>
            <div className="text-[11px] text-slate-500 truncate">{brokerAdapter === 'polarium' ? 'Polarium' : 'Mock (dev)'} · M1</div>
          </div>
          <span className="flex items-center gap-1.5 text-xs text-slate-400 ml-1 shrink-0">
            <span className={`h-2 w-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-rose-500'}`} />
            <span className="hidden xs:inline">{connected ? 'Conectado' : 'Desconectado'}</span>
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <div className="relative">
            <button
              type="button"
              onClick={() => setModeMenuOpen((v) => !v)}
              className={`flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-bold ${MODE_PILL_STYLES[mode]}`}
            >
              {mode} <span className={`transition-transform ${modeMenuOpen ? 'rotate-180' : ''}`}>⌄</span>
            </button>
            {modeMenuOpen && (
              <div className="absolute right-0 mt-1 z-20 w-28 rounded-lg border border-slate-700 bg-slate-900 shadow-lg overflow-hidden">
                {(['DEMO', 'REAL'] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => {
                      onChangeMode(m);
                      setModeMenuOpen(false);
                    }}
                    className={`block w-full text-left px-3 py-1.5 text-xs font-semibold hover:bg-slate-800 ${
                      mode === m ? 'text-white' : 'text-slate-400'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}
          </div>
          {showLogout && (
            <button onClick={onLogout} className="text-xs text-slate-500 hover:text-slate-300 underline underline-offset-2">
              Sair
            </button>
          )}
        </div>
      </div>

      <div className="mt-2.5 rounded-xl border border-slate-800 bg-slate-900 px-3 py-2 flex items-center gap-4 overflow-x-auto">
        <div className="min-w-0">
          <div className="text-xs text-slate-500">Saldo</div>
          <div className="font-bold whitespace-nowrap">
            {balance === null ? '—' : balance.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}
          </div>
        </div>
        <div className="h-7 w-px bg-slate-800 shrink-0" />
        <div className="min-w-0">
          <div className="text-xs text-slate-500">Hoje</div>
          <div className={`font-bold whitespace-nowrap ${pnlColor}`}>
            {dailyResult ? (pnl >= 0 ? `+${pnl.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}` : pnl.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })) : '—'}
          </div>
        </div>
        <div className="h-7 w-px bg-slate-800 shrink-0" />
        <div className="min-w-0 whitespace-nowrap">
          <span className="font-bold">{dailyResult?.operationsCount ?? 0}</span> <span className="text-xs text-slate-500">operações</span>
        </div>
      </div>
    </header>
  );
}
