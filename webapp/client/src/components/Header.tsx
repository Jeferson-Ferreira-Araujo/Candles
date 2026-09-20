import type { AppMode, DailyResult, Settings } from '@polarium12c/shared';

interface Props {
  connected: boolean;
  brokerAdapter: string;
  mode: AppMode;
  robotActive: boolean;
  balance: number | null;
  dailyResult: DailyResult | null;
  settings: Settings | null;
  onToggleRobot: () => void;
  showLogout: boolean;
  onLogout: () => void;
}

const MODE_STYLES: Record<AppMode, string> = {
  OBSERVATION: 'bg-slate-700 text-slate-100',
  DEMO: 'bg-sky-700 text-sky-100',
  REAL: 'bg-rose-700 text-rose-100',
};

export function Header({
  connected,
  brokerAdapter,
  mode,
  robotActive,
  balance,
  dailyResult,
  settings,
  onToggleRobot,
  showLogout,
  onLogout,
}: Props) {
  const pnl = dailyResult?.pnl ?? 0;
  const pnlColor = pnl > 0 ? 'text-emerald-400' : pnl < 0 ? 'text-rose-400' : 'text-slate-300';
  const maxOps = settings?.maxOperationsPerDay ?? null;

  return (
    <header className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2 sm:px-6 sm:py-3 border-b border-slate-800 bg-slate-950">
      <div>
        <div className="font-bold text-base sm:text-lg leading-none">12 Candles</div>
        <div className="text-xs text-slate-500">M1 · {brokerAdapter === 'polarium' ? 'Polarium' : 'Mock (dev)'}</div>
      </div>

      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${connected ? 'bg-emerald-500' : 'bg-rose-500'}`} />
        <span className="text-sm text-slate-300 whitespace-nowrap">{connected ? 'Conectado' : 'Desconectado'}</span>
      </div>

      <div>
        <div className="text-xs text-slate-500">Modo</div>
        <span className={`text-xs font-semibold px-2 py-0.5 rounded ${MODE_STYLES[mode]}`}>{mode}</span>
      </div>

      <div>
        <div className="text-xs text-slate-500">Robô</div>
        <span className={`text-xs font-semibold px-2 py-0.5 rounded ${robotActive ? 'bg-emerald-700 text-emerald-100' : 'bg-slate-700 text-slate-200'}`}>
          {robotActive ? 'ATIVO' : 'PARADO'}
        </span>
      </div>

      <div>
        <div className="text-xs text-slate-500">Saldo</div>
        <div className="font-semibold whitespace-nowrap">
          {balance === null ? '—' : balance.toLocaleString('pt-BR', { style: 'currency', currency: 'USD' })}
        </div>
      </div>

      <div>
        <div className="text-xs text-slate-500">Resultado do dia</div>
        <div className={`font-semibold whitespace-nowrap ${pnlColor}`}>
          {dailyResult ? pnl.toLocaleString('pt-BR', { style: 'currency', currency: 'USD' }) : '—'}
        </div>
      </div>

      <div>
        <div className="text-xs text-slate-500">Operações hoje</div>
        <div className="font-semibold whitespace-nowrap">
          {dailyResult?.operationsCount ?? 0} {maxOps !== null ? `/ ${maxOps}` : ''}
        </div>
      </div>

      <div className="flex gap-2 w-full sm:w-auto sm:ml-auto justify-end order-last sm:order-none">
        <button
          onClick={onToggleRobot}
          className="rounded-lg bg-rose-700 hover:bg-rose-600 transition-colors px-3 py-1.5 sm:px-4 sm:py-2 font-semibold text-xs sm:text-sm whitespace-nowrap"
        >
          {robotActive ? '■ Parar robô' : '▶ Ligar robô'}
        </button>

        {showLogout && (
          <button
            onClick={onLogout}
            className="rounded-lg border border-slate-700 hover:bg-slate-800 transition-colors px-3 py-1.5 sm:px-4 sm:py-2 font-semibold text-xs sm:text-sm text-slate-300"
          >
            Sair
          </button>
        )}
      </div>
    </header>
  );
}
