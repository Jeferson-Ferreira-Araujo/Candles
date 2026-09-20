import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { openDb } from './db/db.js';
import { loadSettings } from './db/repositories.js';

const PORT = Number(process.env.PORT ?? 4000);
const DB_PATH = process.env.DB_PATH ?? './data/app.db';

const db = openDb(DB_PATH);

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, mode: loadSettings(db).mode });
});

app.get('/api/settings', (_req, res) => {
  res.json(loadSettings(db));
});

const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (socket) => {
  socket.send(JSON.stringify({ type: 'HELLO', payload: { message: 'Conectado ao servidor 12 Candles (fase inicial).' } }));
});

httpServer.listen(PORT, () => {
  console.log(`[server] ouvindo em http://localhost:${PORT} (WS em /ws)`);
  console.log('[server] Fases ja implementadas: arquitetura+banco, StrategyEngine 12 Candles.');
  console.log('[server] Ainda NAO implementado nesta etapa: backtest 30D, replay do MockBroker, frontend, integracao ao vivo.');
});
