import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import type { AppEvent } from '@polarium12c/shared';
import { openDb } from './db/db.js';
import { loadSettings, saveSettings, listEvents, getDailyResult, insertEvent } from './db/repositories.js';
import { createBrokerAdapter } from './brokerFactory.js';
import { runBacktest } from './backtest/backtestRunner.js';
import { LiveMonitorService } from './live/LiveMonitorService.js';
import { OrderService } from './orders/OrderService.js';
import { listUnknownOrders, listOrders, updateOrder } from './db/repositories.js';

const PORT = Number(process.env.PORT ?? 4000);
const DB_PATH = process.env.DB_PATH ?? './data/app.db';

const db = openDb(DB_PATH);
const broker = createBrokerAdapter();

let liveMonitor: LiveMonitorService | null = null;
const orderService = new OrderService(db, broker, () => loadSettings(db));
orderService.on('event', broadcast);

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
  if (current.robotActive && !next.robotActive) {
    insertEvent(db, { id: randomUUID(), type: 'KILL_SWITCH', payload: { source: 'user' }, createdAt: Date.now() });
  }
  saveSettings(db, next);
  broadcastRaw('SETTINGS_UPDATED', next);
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

app.get('/api/orders', (req, res) => {
  const limit = Number(req.query.limit ?? 200);
  res.json(listOrders(db, limit));
});

app.get('/api/events', (req, res) => {
  const limit = Number(req.query.limit ?? 200);
  res.json(listEvents(db, limit));
});

app.get('/api/daily-result', (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  res.json(getDailyResult(db, today));
});

app.get('/api/balances', async (_req, res) => {
  try {
    await broker.authenticate();
    const balances = await broker.getBalances();
    res.json(balances);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'HELLO', payload: { message: 'Conectado ao servidor 12 Candles.' } }));
});

function broadcastRaw(type: string, payload: unknown): void {
  const message = JSON.stringify({ type, payload });
  for (const client of wss.clients) {
    if (client.readyState === client.OPEN) client.send(message);
  }
}

function broadcast(event: AppEvent): void {
  broadcastRaw('APP_EVENT', event);
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
  liveMonitor.on('event', (event: AppEvent) => {
    if (event.type !== 'PATTERN_CONFIRMED' || event.activeId === undefined) return;
    const payload = event.payload as { window: unknown; wickPercentage11: number };
    orderService
      .handleConfirmed(event.activeId, payload.window as Parameters<OrderService['handleConfirmed']>[1], payload.wickPercentage11)
      .catch((err) => console.error('[orders] erro ao processar PATTERN_CONFIRMED:', err));
  });
  await liveMonitor.start();
  console.log(`[live] Monitor ao vivo iniciado para os ativos: ${settings.selectedActiveIds.join(', ')}`);
}

/**
 * Reconciliacao de ordens UNKNOWN ao subir o servidor: para as que ja tem brokerOrderId
 * (ou seja, a corretora chegou a confirmar o pedido antes da conexao cair), tenta buscar o
 * resultado real. Ordens sem brokerOrderId (a chamada de rede falhou ANTES de qualquer
 * confirmacao) ficam UNKNOWN permanentemente — nunca sao reenviadas.
 */
async function reconcileUnknownOrders(): Promise<void> {
  const unknown = listUnknownOrders(db).filter((o) => o.brokerOrderId);
  if (unknown.length === 0) return;
  console.log(`[reconcile] ${unknown.length} ordem(ns) UNKNOWN com brokerOrderId — tentando reconciliar...`);
  for (const order of unknown) {
    try {
      const resolution = await broker.getOrderResult(order.brokerOrderId!);
      if (resolution) {
        updateOrder(db, order.id, {
          status: 'FILLED',
          resolvedAt: Date.now(),
          result: resolution.result,
          pnl: resolution.pnl,
          payoutPercentage: resolution.payoutPercentage,
        });
        console.log(`[reconcile] Ordem ${order.id} resolvida: ${resolution.result}`);
      }
    } catch (err) {
      console.error(`[reconcile] Falha ao reconciliar ordem ${order.id}:`, err instanceof Error ? err.message : err);
    }
  }
}

httpServer.listen(PORT, () => {
  console.log(`[server] ouvindo em http://localhost:${PORT} (WS em /ws)`);
  console.log(`[server] BROKER_ADAPTER=${process.env.BROKER_ADAPTER ?? 'mock'}`);
  reconcileUnknownOrders()
    .then(() => startLiveMonitorIfConfigured())
    .catch((err) => console.error('[live] erro inesperado ao iniciar:', err));
});

process.on('SIGINT', async () => {
  liveMonitor?.stop();
  await broker.disconnect().catch(() => {});
  process.exit(0);
});
