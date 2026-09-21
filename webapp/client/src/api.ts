import type {
  AssetInfo,
  BacktestSummary,
  CustomPattern,
  DailyResult,
  OrderRecord,
  PatternDiscoveryResult,
  PatternOccurrence,
  Settings,
} from '@polarium12c/shared';

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

// O backend (Render, plano free) hiberna apos ociosidade e a primeira requisicao que o
// acorda as vezes falha na propria camada de rede (conexao recusada), nao so fica lenta.
// So tentamos de novo em falha de rede (TypeError do fetch) — uma resposta HTTP de verdade
// (401, 500, etc.) e um erro real da aplicacao e nunca deve ser reprocessada.
async function fetchWithRetry(url: string, init: RequestInit, attempts = 3, delayMs = 1500): Promise<Response> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      if (attempt >= attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs * attempt));
    }
  }
}

function req(path: string, init?: RequestInit) {
  return fetchWithRetry(`${BASE}${path}`, { credentials: 'include', ...init });
}

// Login nunca deve ser reenviado automaticamente: se a resposta da 1a tentativa se perder na
// rede mas o servidor ja tiver processado, um reenvio dispara um SEGUNDO login real (nova
// sessao na Polarium substituindo a anterior) quase ao mesmo tempo — corrida que o servidor
// so recentemente passou a tolerar sem cair. Aqui o usuario ve o erro e decide se tenta de novo.
function reqNoRetry(path: string, init?: RequestInit) {
  return fetch(`${BASE}${path}`, { credentials: 'include', ...init });
}

export const api = {
  health: () => req('/api/health').then((r) => json<{ ok: boolean; mode: string; brokerAdapter: string }>(r)),

  authStatus: () => req('/api/auth/status').then((r) => json<AuthStatus>(r)),

  login: (ssid: string) =>
    reqNoRetry('/api/auth/login', {
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

  runBacktest: (activeIds: number[], days: number, patternId?: string) =>
    req('/api/backtest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeIds, days, patternId }),
    }).then((r) => json<{ run: { id: string }; occurrences: PatternOccurrence[]; summary: BacktestSummary }>(r)),

  listPatterns: () => req('/api/patterns').then((r) => json<CustomPattern[]>(r)),

  getActivePattern: () => req('/api/patterns/active').then((r) => json<CustomPattern | null>(r)),

  createPattern: (input: { name: string; candles: CustomPattern['candles'] }) =>
    req('/api/patterns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => json<CustomPattern>(r)),

  activatePattern: (id: string) => req(`/api/patterns/${id}/activate`, { method: 'POST' }).then((r) => json<CustomPattern>(r)),

  deletePattern: (id: string) => req(`/api/patterns/${id}`, { method: 'DELETE' }).then((r) => json<{ ok: true }>(r)),

  discoverPatterns: (activeId: number, days: number) =>
    req('/api/pattern-discovery', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ activeId, days }),
    }).then((r) => json<PatternDiscoveryResult>(r)),

  getEvents: (limit = 200) => req(`/api/events?limit=${limit}`).then((r) => json<import('@polarium12c/shared').AppEvent[]>(r)),

  getDailyResult: () => req('/api/daily-result').then((r) => json<DailyResult>(r)),

  getBalances: () => req('/api/balances').then((r) => json<Balance[]>(r)),

  getOrders: (limit = 200) => req(`/api/orders?limit=${limit}`).then((r) => json<OrderRecord[]>(r)),

  getAssets: () => req('/api/assets').then((r) => json<AssetInfo[]>(r)),
};
