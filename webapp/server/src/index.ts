import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import type { AppEvent, AssetInfo, Direction } from '@polarium12c/shared';
import { confirmPrefix, entryDirectionOf, validatePatternCandles } from '@polarium12c/shared';
import { openDb } from './db/db.js';
import {
  loadSettings,
  saveSettings,
  listEvents,
  getDailyResult,
  insertEvent,
  listUnknownOrders,
  listOrders,
  updateOrder,
  listCustomPatterns,
  getCustomPattern,
  getActivePattern,
  createCustomPattern,
  activateCustomPattern,
  deleteCustomPattern,
} from './db/repositories.js';
import { BrokerManager } from './brokerFactory.js';
import { runBacktest } from './backtest/backtestRunner.js';
import { runPatternDiscovery } from './discovery/patternDiscovery.js';
import { runClassicStrategy } from './strategies/classicStrategies.js';
import { CLASSIC_STRATEGIES, defaultClassicStrategyConfig, type ClassicStrategyId } from '@polarium12c/shared';
import { LiveMonitorService } from './live/LiveMonitorService.js';
import { OrderService } from './orders/OrderService.js';
import { createSession, destroySession, isRequestAuthenticated, requireAuth, SESSION_COOKIE } from './auth/session.js';

const PORT = Number(process.env.PORT ?? 4000);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL nao configurado. Defina a connection string do Postgres (Supabase).');
  process.exit(1);
}

const db = await openDb(DATABASE_URL);
const brokerManager = new BrokerManager();

let liveMonitor: LiveMonitorService | null = null;
let orderService: OrderService | null = null;

const app = express();
app.use(cors({ origin: process.env.CORS_ORIGIN ?? true, credentials: true }));
app.use(express.json());
app.use(cookieParser());

// ============================================================================
// AUTENTICACAO
// ============================================================================
//
// Em modo mock (dev local), nao ha nada real em jogo — todas as rotas ficam abertas.
// Em modo polarium, TUDO abaixo de /api (exceto /api/health e /api/auth/*) exige uma
// sessao valida, que so existe depois de um login bem-sucedido com um SSID real.

app.get('/api/health', async (_req, res) => {
  const settings = await loadSettings(db);
  res.json({ ok: true, mode: settings.mode, brokerAdapter: brokerManager.requiresLogin ? 'polarium' : 'mock' });
});

app.get('/api/auth/status', (req, res) => {
  if (!brokerManager.requiresLogin) {
    res.json({ requiresLogin: false, authenticated: true });
    return;
  }
  res.json({ requiresLogin: true, authenticated: isRequestAuthenticated(req) && brokerManager.isReady() });
});

app.post('/api/auth/login', async (req, res) => {
  const { ssid } = req.body as { ssid?: string };
  if (!brokerManager.requiresLogin) {
    res.json({ ok: true }); // modo mock: login e um no-op, nao ha o que autenticar
    return;
  }
  if (!ssid || typeof ssid !== 'string' || ssid.trim().length === 0) {
    res.status(400).json({ error: 'Informe o SSID.' });
    return;
  }
  try {
    await brokerManager.loginWithSsid(ssid.trim());
  } catch (err) {
    // NUNCA logar o SSID em si — so a mensagem de erro do SDK.
    console.error('[auth] Falha no login:', err instanceof Error ? err.message : err);
    res.status(401).json({ error: 'SSID invalido, expirado, ou a Polarium recusou a conexao.' });
    return;
  }

  const token = createSession();
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    // Em producao o client (Vercel) e o server (Render) ficam em dominios diferentes —
    // isso exige SameSite=None (e Secure, obrigatorio junto com None). Em dev local o
    // client fala com o server via proxy do Vite (mesma origem), entao Lax basta.
    sameSite: IS_PRODUCTION ? 'none' : 'lax',
    secure: IS_PRODUCTION,
    maxAge: 12 * 60 * 60 * 1000,
  });

  await ensureLiveServicesStarted();
  res.json({ ok: true });
});

app.post('/api/auth/logout', async (req, res) => {
  destroySession(req.cookies?.[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE);
  if (brokerManager.requiresLogin) {
    liveMonitor?.stop();
    liveMonitor = null;
    await brokerManager.logout();
  }
  res.json({ ok: true });
});

// Gate: a partir daqui, toda rota /api/* exige sessao valida quando o broker exige login.
app.use('/api', (req, res, next) => {
  if (!brokerManager.requiresLogin) return next();
  return requireAuth(req, res, next);
});

// ============================================================================
// ROTAS DA APLICACAO
// ============================================================================

app.get('/api/settings', async (_req, res) => {
  res.json(await loadSettings(db));
});

app.put('/api/settings', async (req, res) => {
  const current = await loadSettings(db);
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
    await insertEvent(db, { id: randomUUID(), type: 'KILL_SWITCH', payload: { source: 'user' }, createdAt: Date.now() });
  }
  await saveSettings(db, next);
  broadcastRaw('SETTINGS_UPDATED', next);
  res.json(next);
});

app.post('/api/backtest', async (req, res) => {
  const { activeIds, days, patternId } = req.body as { activeIds?: number[]; days?: number; patternId?: string };
  if (!Array.isArray(activeIds) || activeIds.length === 0 || !Number.isFinite(days) || (days ?? 0) <= 0) {
    res.status(400).json({ error: 'Informe activeIds (array nao vazio) e days (numero positivo).' });
    return;
  }
  const pattern = patternId ? await getCustomPattern(db, patternId) : await getActivePattern(db);
  if (!pattern) {
    res.status(400).json({ error: 'Nenhum padrão disponível. Crie um padrão na tela de Padrão.' });
    return;
  }
  try {
    const result = await runBacktest(
      db,
      brokerManager.get(),
      activeIds,
      days!,
      confirmPrefix(pattern.candles),
      entryDirectionOf(pattern.candles)
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post('/api/pattern-discovery', async (req, res) => {
  const { activeId, days } = req.body as { activeId?: number; days?: number };
  if (!Number.isFinite(activeId) || !Number.isFinite(days) || (days ?? 0) <= 0) {
    res.status(400).json({ error: 'Informe activeId e days (numero positivo).' });
    return;
  }
  try {
    const result = await runPatternDiscovery(brokerManager.get(), activeId!, days!);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const CLASSIC_STRATEGY_IDS: ClassicStrategyId[] = CLASSIC_STRATEGIES.map((s) => s.id);

app.post('/api/classic-strategy', async (req, res) => {
  const { activeId, days, strategyId } = req.body as { activeId?: number; days?: number; strategyId?: ClassicStrategyId };
  if (!Number.isFinite(activeId) || !Number.isFinite(days) || (days ?? 0) <= 0) {
    res.status(400).json({ error: 'Informe activeId e days (numero positivo).' });
    return;
  }
  if (!strategyId || !CLASSIC_STRATEGY_IDS.includes(strategyId)) {
    res.status(400).json({ error: 'Informe um strategyId válido.' });
    return;
  }
  try {
    // A regra de cada estrategia e sempre a definicao padrao (nao editavel pelo usuario) —
    // ver defaultClassicStrategyConfig em shared/src/classicStrategies.ts.
    const strategy = defaultClassicStrategyConfig(strategyId);
    const result = await runClassicStrategy(brokerManager.get(), activeId!, days!, strategy);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get('/api/patterns', async (_req, res) => {
  res.json(await listCustomPatterns(db));
});

app.get('/api/patterns/active', async (_req, res) => {
  res.json((await getActivePattern(db)) ?? null);
});

app.post('/api/patterns', async (req, res) => {
  const { name, candles } = req.body as { name?: string; candles?: unknown };
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    res.status(400).json({ error: 'Informe um nome para o padrão.' });
    return;
  }
  if (!validatePatternCandles(candles)) {
    res.status(400).json({ error: 'O padrão precisa ter pelo menos 2 casas, cada uma verde ou vermelha.' });
    return;
  }
  const pattern = await createCustomPattern(db, { name: name.trim(), candles });
  res.json(pattern);
});

app.post('/api/patterns/:id/activate', async (req, res) => {
  const pattern = await activateCustomPattern(db, req.params.id);
  if (!pattern) {
    res.status(404).json({ error: 'Padrão não encontrado.' });
    return;
  }
  await ensureLiveServicesStarted();
  broadcastRaw('PATTERN_ACTIVATED', pattern);
  res.json(pattern);
});

app.delete('/api/patterns/:id', async (req, res) => {
  const pattern = await getCustomPattern(db, req.params.id);
  if (pattern?.isActive) {
    res.status(400).json({ error: 'Não é possível excluir o padrão ativo. Ative outro antes.' });
    return;
  }
  await deleteCustomPattern(db, req.params.id);
  res.json({ ok: true });
});

app.get('/api/orders', async (req, res) => {
  const limit = Number(req.query.limit ?? 200);
  res.json(await listOrders(db, limit));
});

app.get('/api/events', async (req, res) => {
  const limit = Number(req.query.limit ?? 200);
  res.json(await listEvents(db, limit));
});

app.get('/api/daily-result', async (_req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  res.json(await getDailyResult(db, today));
});

app.get('/api/balances', async (_req, res) => {
  try {
    const balances = await brokerManager.get().getBalances();
    res.json(balances);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Lista de ativos (nome/OTC/tipos) muda raramente — cache curto em memoria evita repetir
// varias chamadas ao SDK a cada vez que o usuario abre o seletor de ativos.
let assetsCache: { at: number; data: AssetInfo[] } | null = null;
const ASSETS_CACHE_TTL_MS = 5 * 60 * 1000;

app.get('/api/assets', async (_req, res) => {
  try {
    if (!assetsCache || Date.now() - assetsCache.at > ASSETS_CACHE_TTL_MS) {
      const data = await brokerManager.get().listAssets();
      assetsCache = { at: Date.now(), data };
    }
    res.json(assetsCache!.data);
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

/**
 * (Re)inicia o monitor ao vivo e o servico de ordens usando o broker atualmente
 * autenticado. Chamado na subida do processo (modo mock, ou modo polarium se por algum
 * motivo ja houver uma sessao — normalmente nao havera) e sempre apos um login bem-sucedido.
 */
async function ensureLiveServicesStarted(): Promise<void> {
  liveMonitor?.stop();
  liveMonitor = null;

  if (!brokerManager.isReady()) return;
  const broker = brokerManager.get();

  const settings = await loadSettings(db);

  orderService = new OrderService(db, broker, () => loadSettings(db));
  orderService.on('event', broadcast);

  if (settings.selectedActiveIds.length === 0) {
    console.log('[live] Nenhum ativo selecionado nas configuracoes — monitor ao vivo nao iniciado.');
    return;
  }

  const activePattern = await getActivePattern(db);
  if (!activePattern) {
    console.log('[live] Nenhum padrão ativo — monitor ao vivo não iniciado. Crie e ative um padrão na tela de Padrão.');
    return;
  }

  liveMonitor = new LiveMonitorService(
    db,
    broker,
    settings.selectedActiveIds,
    confirmPrefix(activePattern.candles),
    entryDirectionOf(activePattern.candles)
  );
  liveMonitor.on('event', broadcast);
  liveMonitor.on('event', (event: AppEvent) => {
    if (event.type !== 'PATTERN_CONFIRMED' || event.activeId === undefined) return;
    const payload = event.payload as { window: unknown; wickPercentage11: number; direction: Direction };
    orderService!
      .handleConfirmed(
        event.activeId,
        payload.window as Parameters<OrderService['handleConfirmed']>[1],
        payload.wickPercentage11,
        payload.direction
      )
      .catch((err) => console.error('[orders] erro ao processar PATTERN_CONFIRMED:', err));
  });
  await liveMonitor.start();
  console.log(
    `[live] Monitor ao vivo iniciado para os ativos: ${settings.selectedActiveIds.join(', ')} (padrão "${activePattern.name}")`
  );
}

/**
 * Reconciliacao de ordens UNKNOWN ao subir o servidor: para as que ja tem brokerOrderId
 * (ou seja, a corretora chegou a confirmar o pedido antes da conexao cair), tenta buscar o
 * resultado real. Ordens sem brokerOrderId (a chamada de rede falhou ANTES de qualquer
 * confirmacao) ficam UNKNOWN permanentemente — nunca sao reenviadas.
 */
async function reconcileUnknownOrders(): Promise<void> {
  if (!brokerManager.isReady()) return; // sem sessao (modo polarium sem login ainda) — nada a reconciliar agora
  const broker = brokerManager.get();
  const unknown = (await listUnknownOrders(db)).filter((o) => o.brokerOrderId);
  if (unknown.length === 0) return;
  console.log(`[reconcile] ${unknown.length} ordem(ns) UNKNOWN com brokerOrderId — tentando reconciliar...`);
  for (const order of unknown) {
    try {
      const resolution = await broker.getOrderResult(order.brokerOrderId!);
      if (resolution) {
        await updateOrder(db, order.id, {
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

// Rede de seguranca de ultima instancia: a SDK da Polarium as vezes rejeita promises
// internamente em metodos que ela mesma tipa como sincronos/void (ja confirmado no caso de
// unsubscribeOnLastCandleChanged() ao desconectar), entao um catch/try local nem sempre
// alcanca a origem real do erro. Sem isto, essas rejeicoes derrubam o processo inteiro
// (Node trata unhandledRejection como fatal por padrao) mesmo quando nao ha nenhuma ordem
// ou operacao em risco — so registramos e seguimos rodando.
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection (processo continua rodando):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException (processo continua rodando):', err);
});

httpServer.listen(PORT, () => {
  console.log(`[server] ouvindo em http://localhost:${PORT} (WS em /ws)`);
  console.log(`[server] BROKER_ADAPTER=${brokerManager.requiresLogin ? 'polarium' : 'mock'}`);
  if (brokerManager.requiresLogin) {
    console.log('[server] Aguardando login via POST /api/auth/login (tela de login do frontend).');
  }
  reconcileUnknownOrders()
    .then(() => ensureLiveServicesStarted())
    .catch((err) => console.error('[live] erro inesperado ao iniciar:', err));
});

process.on('SIGINT', async () => {
  liveMonitor?.stop();
  if (brokerManager.isReady()) await brokerManager.get().disconnect().catch(() => {});
  process.exit(0);
});
