import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout.js';
import { MonitorPage } from './pages/MonitorPage.js';
import { BacktestPage } from './pages/BacktestPage.js';
import { OperationsPage } from './pages/OperationsPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { LogsPage } from './pages/LogsPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { api, type AuthStatus } from './api.js';

export default function App() {
  const [status, setStatus] = useState<AuthStatus | null>(null);

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

  if (status === null) {
    return <div className="min-h-screen bg-slate-950 text-slate-400 flex items-center justify-center">Carregando...</div>;
  }

  const needsLogin = status.requiresLogin && !status.authenticated;

  return (
    <Routes>
      <Route path="/login" element={needsLogin ? <LoginPage onLoggedIn={refreshStatus} /> : <Navigate to="/" replace />} />
      <Route element={needsLogin ? <Navigate to="/login" replace /> : <Layout onLoggedOut={refreshStatus} requiresLogin={status.requiresLogin} />}>
        <Route index element={<MonitorPage />} />
        <Route path="backtest" element={<BacktestPage />} />
        <Route path="operations" element={<OperationsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="logs" element={<LogsPage />} />
      </Route>
    </Routes>
  );
}
