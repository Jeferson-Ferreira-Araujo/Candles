import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import type { AssetInfo, BacktestSummary } from '@polarium12c/shared';
import { Layout } from './components/Layout.js';
import { MonitorPage } from './pages/MonitorPage.js';
import { BacktestPage } from './pages/BacktestPage.js';
import { OperationsPage } from './pages/OperationsPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { LogsPage } from './pages/LogsPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { api, type AuthStatus } from './api.js';

export type AutoAnalysisState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'empty' }
  | { status: 'done'; summary: BacktestSummary; assets: AssetInfo[] }
  | { status: 'error'; message: string };

const AUTO_ANALYSIS_DAYS = 7;

export default function App() {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [autoAnalysis, setAutoAnalysis] = useState<AutoAnalysisState>({ status: 'idle' });

  async function refreshStatus() {
    try {
      setStatus(await api.authStatus());
    } catch {
      setStatus({ requiresLogin: true, authenticated: false });
    }
  }

  useEffect(() => {
    refreshStatus();
  }, []);

  // Roda automaticamente so no momento do login (nao a cada reload de pagina): pega todos
  // os ativos OTC digital disponiveis (/api/assets ja vem filtrado assim) e consolida os
  // ultimos 7 dias da estrategia 12 Candles sobre eles.
  async function runAutoAnalysis() {
    setAutoAnalysis({ status: 'loading' });
    try {
      const assets = await api.getAssets();
      if (assets.length === 0) {
        setAutoAnalysis({ status: 'empty' });
        return;
      }
      const { summary } = await api.runBacktest(
        assets.map((a) => a.id),
        AUTO_ANALYSIS_DAYS
      );
      setAutoAnalysis({ status: 'done', summary, assets });
    } catch (err) {
      setAutoAnalysis({ status: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function handleLoggedIn() {
    await refreshStatus();
    runAutoAnalysis();
  }

  if (status === null) {
    return <div className="min-h-screen bg-slate-950 text-slate-400 flex items-center justify-center">Carregando...</div>;
  }

  const needsLogin = status.requiresLogin && !status.authenticated;

  return (
    <Routes>
      <Route path="/login" element={needsLogin ? <LoginPage onLoggedIn={handleLoggedIn} /> : <Navigate to="/" replace />} />
      <Route
        element={
          needsLogin ? (
            <Navigate to="/login" replace />
          ) : (
            <Layout onLoggedOut={refreshStatus} requiresLogin={status.requiresLogin} autoAnalysis={autoAnalysis} />
          )
        }
      >
        <Route index element={<MonitorPage />} />
        <Route path="backtest" element={<BacktestPage />} />
        <Route path="operations" element={<OperationsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="logs" element={<LogsPage />} />
      </Route>
    </Routes>
  );
}
