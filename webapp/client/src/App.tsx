import { Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout.js';
import { MonitorPage } from './pages/MonitorPage.js';
import { BacktestPage } from './pages/BacktestPage.js';
import { OperationsPage } from './pages/OperationsPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { LogsPage } from './pages/LogsPage.js';

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<MonitorPage />} />
        <Route path="backtest" element={<BacktestPage />} />
        <Route path="operations" element={<OperationsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="logs" element={<LogsPage />} />
      </Route>
    </Routes>
  );
}
