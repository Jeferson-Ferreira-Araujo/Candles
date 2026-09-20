import type { AssetInfo, BacktestSummary, DailyResult, OrderRecord, PatternOccurrence, Settings } from '@polarium12c/shared';

interface Balance {
  id: string;
  type: string;
  amount: number;
  currency?: string;
}

export interface AuthStatus {
  requiresLogin: boolean;
  authenticated: boolean;
}

// Em dev local, vazio (o proxy do Vite encaminha /api para http://localhost:4000). Em
// producao, aponte para a URL publica do backend no Render via VITE_API_BASE_URL.
const BASE = import.meta.env.VITE_API_BASE_URL ?? '';

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body.error ?? `Erro HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

function req(path: string, init?: RequestInit) {
  return fetch(`${BASE}${path}`, { credentials: 'include', ...init });
}

export const api = {
  health: () => req('/api/health').then((r) => json<{ ok: boolean; mode: string; brokerAdapter: string }>(r)),

  authStatus: () => req('/api/auth/status').then((r) => json<AuthStatus>(r)),

  login: (ssid: string) =>
    req('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ssid }),
    }).then((r) => json<{ ok: true }>(r)),

  logout: () => req('/api/auth/logout', { method: 'POST' }).then((r) => json<{ ok: true }>(r)),

  getSettings: () => req('/api/settings').then((r) => json<Settings>(r)),

  saveSettings: (settings: Partial<Settings>) =>
    req('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    }).then((r) => json<Settings>(r)),

  runBacktest: (activeIds: number[], days: number) =>
    req('/api/backtest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeIds, days }),
    }).then((r) => json<{ run: { id: string }; occurrences: PatternOccurrence[]; summary: BacktestSummary }>(r)),

  getEvents: (limit = 200) => req(`/api/events?limit=${limit}`).then((r) => json<import('@polarium12c/shared').AppEvent[]>(r)),

  getDailyResult: () => req('/api/daily-result').then((r) => json<DailyResult>(r)),

  getBalances: () => req('/api/balances').then((r) => json<Balance[]>(r)),

  getOrders: (limit = 200) => req(`/api/orders?limit=${limit}`).then((r) => json<OrderRecord[]>(r)),

  getAssets: () => req('/api/assets').then((r) => json<AssetInfo[]>(r)),
};
