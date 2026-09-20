import type { BacktestSummary, DailyResult, PatternOccurrence, Settings } from '@polarium12c/shared';

interface Balance {
  id: string;
  type: string;
  amount: number;
  currency?: string;
}

const BASE = ''; // usa o proxy do Vite (/api -> http://localhost:4000)

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Erro HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => fetch(`${BASE}/api/health`).then((r) => json<{ ok: boolean; mode: string; brokerAdapter: string }>(r)),

  getSettings: () => fetch(`${BASE}/api/settings`).then((r) => json<Settings>(r)),

  saveSettings: (settings: Partial<Settings>) =>
    fetch(`${BASE}/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    }).then((r) => json<Settings>(r)),

  runBacktest: (activeIds: number[], days: number) =>
    fetch(`${BASE}/api/backtest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeIds, days }),
    }).then((r) =>
      json<{ run: { id: string }; occurrences: PatternOccurrence[]; summary: BacktestSummary }>(r)
    ),

  getEvents: (limit = 200) => fetch(`${BASE}/api/events?limit=${limit}`).then((r) => json<import('@polarium12c/shared').AppEvent[]>(r)),

  getDailyResult: () => fetch(`${BASE}/api/daily-result`).then((r) => json<DailyResult>(r)),

  getBalances: () => fetch(`${BASE}/api/balances`).then((r) => json<Balance[]>(r)),
};
