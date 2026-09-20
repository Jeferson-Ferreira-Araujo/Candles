import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import type { AppEvent } from '@polarium12c/shared';
import { openDb } from './db/db.js';
import { loadSettings, saveSettings, listEvents } from './db/repositories.js';
import { createBrokerAdapter } from './brokerFactory.js';
import { runBacktest } from './backtest/backtestRunner.js';
import { LiveMonitorService } from './live/LiveMonitorService.js';

const PORT = Number(process.env.PORT ?? 4000);
const DB_PATH = process.env.DB_PATH ?? './data/app.db';

const db = openDb(DB_PATH);
const broker = createBrokerAdapter();

let liveMonitor: LiveMonitorService | null = null;

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, mode: loadSettings(db).mode, brokerAdapter: process.env.BROKER_ADAPTER ?? 'mock' });
});

app.get('/api/settings', (_req, res) => {
  res.json(loadSettings(db));
});

app.put('/api/settings', (req, res) => {
  const current = loadSettings(db);
  const next = { ...current, ...req.body };
  if (next.entryAmount < 5) {
    res.status(400).json({ error: 'entryAmount minimo e 5.' });
    return;
  }
  if (next.galeEnabled && next.galeMaxLevels > 1) {
    res.status(400).json({ error: 'galeMaxLevels maximo e 1.' });
    return;
  }
  saveSettings(db, next);
  res.json(next);
});

app.post('/api/backtest', async (req, res) => {
  const { activeIds, days } = req.body as { activeIds?: number[]; days?: number };
  if (!Array.isArray(activeIds) || activeIds.length === 0 || !Number.isFinite(days) || (days ?? 0) <= 0) {
    res.status(400).json({ error: 'Informe activeIds (array nao vazio) e days (numero positivo).' });
    return;
  }
  try {
    await broker.authenticate();
    const result = await runBacktest(db, broker, activeIds, days!);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/events', (req, res) => {
  const limit = Number(req.query.limit ?? 200);
  res.json(listEvents(db, limit));
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'HELLO', payload: { message: 'Conectado ao servidor 12 Candles.' } }));
});

function broadcast(event: AppEvent): void {
  const message = JSON.stringify({ type: 'APP_EVENT', payload: event });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(message);
  }
}

async function startLiveMonitorIfConfigured(): Promise<void> {
  const settings = loadSettings(db);
  if (settings.selectedActiveIds.length === 0) {
    console.log('[live] Nenhum ativo selecionado nas configuracoes — monitor ao vivo nao iniciado.');
    return;
  }
  try {
    await broker.authenticate();
  } catch (err) {
    console.error('[live] Falha ao autenticar no broker — monitor ao vivo NAO iniciado (na duvida, nao operar).');
    console.error(err instanceof Error ? err.message : err);
    return;
  }
  liveMonitor = new LiveMonitorService(db, broker, settings.selectedActiveIds);
  liveMonitor.on('event', broadcast);
  await liveMonitor.start();
  console.log(`[live] Monitor ao vivo iniciado para os ativos: ${settings.selectedActiveIds.join(', ')}`);
}

httpServer.listen(PORT, () => {
  console.log(`[server] ouvindo em http://localhost:${PORT} (WS em /ws)`);
  console.log(`[server] BROKER_ADAPTER=${process.env.BROKER_ADAPTER ?? 'mock'}`);
  startLiveMonitorIfConfigured().catch((err) => console.error('[live] erro inesperado ao iniciar:', err));
});

process.on('SIGINT', async () => {
  liveMonitor?.stop();
  await broker.disconnect().catch(() => {});
  process.exit(0);
});
