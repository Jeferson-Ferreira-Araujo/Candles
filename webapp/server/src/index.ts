import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import type { AppEvent, AssetInfo, Direction } from '@polarium12c/shared';
import { CANDLE_SIZE_M1 } from '@polarium12c/shared';
import { confirmPrefix, entryDirectionOf, validatePatternCandles } from '@polarium12c/shared';
import { openDb } from './db/db.js';
import {
  loadSettings,
  saveSettings,
  listEvents,
  getDailyResult,
  insertEvent,
  listUnknownOrders,
  listConfirmedOrders,
  listOrders,
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
import {
  runClassicStrategy,
  runAllClassicStrategiesForAsset,
  detectPendingSignal,
  fetchClosedCandles,
  computeClassicStrategyResult,
  getCurrentSupportResistanceLevels,
  startOfTodayUtc,
} from './strategies/classicStrategies.js';
import { CLASSIC_STRATEGIES, defaultClassicStrategyConfig, type ClassicStrategyId } from '@polarium12c/shared';
import { LiveMonitorService } from './live/LiveMonitorService.js';
import { OrderService } from './orders/OrderService.js';
import { WatchlistWatcher } from './live/WatchlistWatcher.js';
import { createSession, destroySession, isRequestAuthenticated, requireAuth, SESSION_COOKIE } from './auth/session.js';
import { loginWithCredentials } from './auth/polariumHeadlessLogin.js';

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
let watchlistWatcher: WatchlistWatcher | null = null;

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

// Completa o login (cria sessao + cookie + sobe os servicos ao vivo) uma vez que ja temos
// um SSID valido em maos — usado tanto pelo login manual (cola o SSID) quanto pelo login
// automatico por email/senha (ve-lo abaixo).
async function finishLogin(res: import('express').Response): Promise<void> {
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
  // Nao bloqueia a resposta do login — ordens presas de uma sessao anterior (ver
  // reconcileStuckOrders) sao reconciliadas em segundo plano assim que a sessao nova sobe.
  reconcileStuckOrders().catch((err) => console.error('[reconcile] erro inesperado:', err));
  res.json({ ok: true });
}

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

  await finishLogin(res);
});

// Login direto com email/senha da Polarium: abre um Chromium headless, loga na tela oficial
// deles e intercepta o SSID da propria conexao WebSocket que a pagina abre — poupa o usuario
// de ter que ir no DevTools (impraticavel no celular) toda vez que o SSID expira. A senha
// nunca e persistida: so existe na memoria deste request, pelo tempo do login automatizado.
app.post('/api/auth/login-credentials', async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!brokerManager.requiresLogin) {
    res.json({ ok: true });
    return;
  }
  if (!email || !password) {
    res.status(400).json({ error: 'Informe email e senha.' });
    return;
  }
  let ssid: string;
  try {
    ssid = await loginWithCredentials(email.trim(), password);
  } catch (err) {
    // NUNCA logar a senha — so a mensagem de erro (ja vem sem a senha, da propria Polarium).
    console.error('[auth] Falha no login automatico:', err instanceof Error ? err.message : err);
    res.status(401).json({ error: err instanceof Error ? err.message : 'Nao foi possivel entrar com essas credenciais.' });
    return;
  }
  try {
    await brokerManager.loginWithSsid(ssid);
  } catch (err) {
    console.error('[auth] SSID obtido mas o broker recusou a conexao:', err instanceof Error ? err.message : err);
    res.status(401).json({ error: 'Login na Polarium funcionou, mas a conexao com o broker falhou. Tente novamente.' });
    return;
  }

  await finishLogin(res);
});

app.post('/api/auth/logout', async (req, res) => {
  destroySession(req.cookies?.[SESSION_COOKIE]);
  res.clearCookie(SESSION_COOKIE);
  if (brokerManager.requiresLogin) {
    liveMonitor?.stop();
    liveMonitor = null;
    await watchlistWatcher?.stop();
    watchlistWatcher = null;
    await stopChartStream();
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
  if (next.galeEnabled && (next.galeMaxLevels < 1 || next.galeMaxLevels > 2)) {
    res.status(400).json({ error: 'galeMaxLevels deve ser 1 ou 2 quando o Gale esta ativado.' });
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

// Verifica se o setup da estrategia acabou de se completar na ultima vela fechada — ou seja,
// se a vela ainda se formando AGORA ja e a entrada (compra/venda). So pra estrategias
// classicas por enquanto (o padrao customizado ja tem sinalizacao ao vivo propria via
// LiveMonitorService/PATTERN_CONFIRMED, quando o ativo esta entre os monitorados).
app.post('/api/classic-strategy/pending', async (req, res) => {
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
    const now = Math.floor(Date.now() / 1000);
    const from = startOfTodayUtc() - (days! - 1) * 24 * 60 * 60;
    const candles = (await brokerManager.get().getHistoricalCandles(activeId!, CANDLE_SIZE_M1, from, now))
      .filter((c) => c.isClosed)
      .sort((a, b) => a.from - b.from);
    const strategy = defaultClassicStrategyConfig(strategyId);
    const pending = detectPendingSignal(candles, strategy);
    res.json({ pending });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

// Niveis de Suporte/Resistencia validados pro ativo atual — so pra DESENHAR no grafico (linha
// tracejada, ver CandleChart), nao pra decidir sinal (isso fica dentro do detector mesmo,
// que tem cuidado extra pra nunca usar um nivel que so ficou conhecido DEPOIS da vela avaliada).
app.post('/api/support-resistance-levels', async (req, res) => {
  const { activeId, days } = req.body as { activeId?: number; days?: number };
  if (!Number.isFinite(activeId) || !Number.isFinite(days) || (days ?? 0) <= 0) {
    res.status(400).json({ error: 'Informe activeId e days (numero positivo).' });
    return;
  }
  try {
    const candles = await fetchClosedCandles(brokerManager.get(), activeId!, days!);
    const levels = getCurrentSupportResistanceLevels(candles);
    res.json(levels);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

const SCAN_ALL_ASSETS_CONCURRENCY = 5;
const SCAN_ALL_ASSETS_MIN_OCCURRENCES = 3;
const ALL_CLASSIC_STRATEGY_CONFIGS = CLASSIC_STRATEGIES.map((s) => defaultClassicStrategyConfig(s.id));

interface AssetScanRanking {
  activeId: number;
  assetName: string;
  strategyId: ClassicStrategyId;
  strategyName: string;
  winRate: number;
  wins: number;
  losses: number;
  dojis: number;
  occurrences: number;
  /** So preenchido pela varredura de UMA estrategia (/api/scan-strategy) — se o setup esta se
   * formando AGORA nesse ativo. undefined na varredura geral (/api/scan-all-assets). */
  pendingDirection?: Direction | null;
}

/**
 * Roda as 10 estrategias classicas em TODOS os ativos (um periodo curto, tipicamente 1 dia) e
 * devolve o ranking por taxa de acerto — usado pela tela "Grafico" pra sugerir o melhor
 * ativo+estrategia do momento, assim que a pagina carrega. Pesado de proposito (e uma varredura
 * completa): busca o historico de CADA ativo uma unica vez (nao uma vez por estrategia) e limita
 * a concorrencia entre ativos pra nao sobrecarregar a conexao com a corretora.
 */
app.post('/api/scan-all-assets', async (req, res) => {
  const { days } = req.body as { days?: number };
  if (!Number.isFinite(days) || (days ?? 0) <= 0) {
    res.status(400).json({ error: 'Informe days (numero positivo).' });
    return;
  }
  const startedAt = Date.now();
  try {
    const assets = await brokerManager.get().listAssets();
    const ranking: AssetScanRanking[] = [];
    let cursor = 0;

    async function worker(): Promise<void> {
      for (;;) {
        const i = cursor++;
        if (i >= assets.length) return;
        const asset = assets[i]!;
        try {
          const results = await runAllClassicStrategiesForAsset(brokerManager.get(), asset.id, days!, ALL_CLASSIC_STRATEGY_CONFIGS);
          for (const r of results) {
            const total = r.summary.wins + r.summary.losses + r.summary.dojis;
            if (total < SCAN_ALL_ASSETS_MIN_OCCURRENCES) continue;
            const winRate = r.summary.wins / total;
            ranking.push({
              activeId: asset.id,
              assetName: asset.name,
              strategyId: r.strategy.id,
              strategyName: CLASSIC_STRATEGIES.find((s) => s.id === r.strategy.id)!.name,
              winRate,
              wins: r.summary.wins,
              losses: r.summary.losses,
              dojis: r.summary.dojis,
              occurrences: total,
            });
          }
        } catch (err) {
          // Um ativo falhar (ex.: sem historico suficiente) nao deve derrubar a varredura inteira.
          console.error(`[scan-all-assets] falha no ativo ${asset.id}:`, err instanceof Error ? err.message : err);
        }
      }
    }

    await Promise.all(Array.from({ length: SCAN_ALL_ASSETS_CONCURRENCY }, () => worker()));

    ranking.sort((a, b) => b.winRate - a.winRate || b.occurrences - a.occurrences);
    res.json({
      best: ranking[0] ?? null,
      top: ranking.slice(0, 20),
      assetsScanned: assets.length,
      tookMs: Date.now() - startedAt,
    });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Varredura de UMA estrategia escolhida pelo usuario em TODOS os ativos — fluxo "escolho a
 * estrategia, o app me diz em quais ativos ela esta valendo a pena e em quais esta se formando
 * agora", ao contrario de /api/scan-all-assets (que testa as 10 estrategias e so reporta a
 * MELHOR combinacao). Busca o historico de cada ativo uma unica vez e reaproveita pra calcular
 * tanto o desempenho historico (wins/losses) quanto se o setup esta pendente AGORA
 * (detectPendingSignal, mesma logica do aviso "ENTRADA AGORA").
 */
app.post('/api/scan-strategy', async (req, res) => {
  const { strategyId, days } = req.body as { strategyId?: ClassicStrategyId; days?: number };
  if (!strategyId || !CLASSIC_STRATEGY_IDS.includes(strategyId)) {
    res.status(400).json({ error: 'Informe um strategyId válido.' });
    return;
  }
  if (!Number.isFinite(days) || (days ?? 0) <= 0) {
    res.status(400).json({ error: 'Informe days (numero positivo).' });
    return;
  }
  const safeStrategyId: ClassicStrategyId = strategyId;
  const strategy = defaultClassicStrategyConfig(safeStrategyId);
  const strategyName = CLASSIC_STRATEGIES.find((s) => s.id === safeStrategyId)!.name;
  const startedAt = Date.now();
  try {
    const assets = await brokerManager.get().listAssets();
    const ranking: AssetScanRanking[] = [];
    let cursor = 0;

    async function worker(): Promise<void> {
      for (;;) {
        const i = cursor++;
        if (i >= assets.length) return;
        const asset = assets[i]!;
        try {
          const candles = await fetchClosedCandles(brokerManager.get(), asset.id, days!);
          const result = computeClassicStrategyResult(candles, asset.id, days!, strategy);
          const total = result.summary.wins + result.summary.losses + result.summary.dojis;
          const pending = detectPendingSignal(candles, strategy);
          ranking.push({
            activeId: asset.id,
            assetName: asset.name,
            strategyId: safeStrategyId,
            strategyName,
            winRate: total > 0 ? result.summary.wins / total : 0,
            wins: result.summary.wins,
            losses: result.summary.losses,
            dojis: result.summary.dojis,
            occurrences: total,
            pendingDirection: pending?.direction ?? null,
          });
        } catch (err) {
          console.error(`[scan-strategy] falha no ativo ${asset.id}:`, err instanceof Error ? err.message : err);
        }
      }
    }

    await Promise.all(Array.from({ length: SCAN_ALL_ASSETS_CONCURRENCY }, () => worker()));

    // Ativos com o setup se formando AGORA sempre primeiro — sao a informacao mais acionavel —
    // depois por taxa de acerto (desempate por numero de ocorrencias).
    ranking.sort((a, b) => {
      const aPending = a.pendingDirection != null;
      const bPending = b.pendingDirection != null;
      if (aPending !== bPending) return aPending ? -1 : 1;
      return b.winRate - a.winRate || b.occurrences - a.occurrences;
    });

    res.json({
      strategyId: safeStrategyId,
      strategyName,
      best: ranking[0] ?? null,
      top: ranking.slice(0, 5),
      assetsScanned: assets.length,
      tookMs: Date.now() - startedAt,
    });
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

// Ordem manual — clique do usuario nos botoes Comprar/Vender. Passa pelo MESMO SafetyGate
// de qualquer outra ordem (kill switch, stop win/loss, saldo, etc.) — nunca pula a checagem
// so porque foi um clique manual.
app.post('/api/orders/manual', async (req, res) => {
  const { activeId, direction } = req.body as { activeId?: number; direction?: Direction };
  if (!orderService) {
    res.status(400).json({ error: 'Serviço de ordens não está pronto (faça login primeiro).' });
    return;
  }
  if (!Number.isFinite(activeId) || (direction !== 'CALL' && direction !== 'PUT')) {
    res.status(400).json({ error: 'Informe activeId e direction ("CALL" ou "PUT").' });
    return;
  }
  try {
    const outcome = await orderService.placeManualOrder(activeId!, direction);
    res.json(outcome);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
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

app.get('/api/candles', async (req, res) => {
  const activeId = Number(req.query.activeId);
  const days = Number(req.query.days ?? 7);
  if (!Number.isFinite(activeId) || !Number.isFinite(days) || days <= 0) {
    res.status(400).json({ error: 'Informe activeId e days (numero positivo) como query params.' });
    return;
  }
  try {
    const now = Math.floor(Date.now() / 1000);
    const from = startOfTodayUtc() - (days - 1) * 24 * 60 * 60;
    const candles = (await brokerManager.get().getHistoricalCandles(activeId, CANDLE_SIZE_M1, from, now))
      .filter((c) => c.isClosed)
      .sort((a, b) => a.from - b.from);
    res.json(candles);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

/**
 * Stream de candles so pra visualizacao (tela Gráfico) — INDEPENDENTE do monitor de padroes
 * (LiveMonitorService): nao exige que o ativo esteja em Settings.selectedActiveIds nem que
 * exista um padrao ativo, so pra poder abrir o grafico de qualquer ativo e ver as velas se
 * mexendo. So mantem 1 assinatura por vez (app de usuario unico) — pedir um novo activeId
 * cancela a anterior. Nunca persiste nada (mesma logica de CANDLE_UPDATED do monitor: sem
 * valor de auditoria), so transmite via WebSocket.
 */
let chartStreamUnsubscribe: (() => void) | null = null;
let chartStreamActiveId: number | null = null;

async function stopChartStream(): Promise<void> {
  if (chartStreamUnsubscribe) {
    try {
      await chartStreamUnsubscribe();
    } catch (err) {
      console.error('[chart] falha ao cancelar stream (ignorada):', err);
    }
  }
  chartStreamUnsubscribe = null;
  chartStreamActiveId = null;
}

app.post('/api/chart-stream', async (req, res) => {
  const { activeId } = req.body as { activeId?: number };
  if (!Number.isFinite(activeId)) {
    res.status(400).json({ error: 'Informe activeId.' });
    return;
  }
  if (chartStreamActiveId === activeId) {
    res.json({ ok: true });
    return;
  }
  try {
    await stopChartStream();
    const unsubscribe = await brokerManager.get().subscribeCandles(activeId!, CANDLE_SIZE_M1, (candle) => {
      broadcastRaw('APP_EVENT', {
        id: randomUUID(),
        type: candle.isClosed ? 'CANDLE_CLOSED' : 'CANDLE_UPDATED',
        activeId,
        payload: { candle },
        createdAt: Date.now(),
      });
    });
    chartStreamUnsubscribe = unsubscribe;
    chartStreamActiveId = activeId!;
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete('/api/chart-stream', async (_req, res) => {
  await stopChartStream();
  res.json({ ok: true });
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
  await watchlistWatcher?.stop();
  watchlistWatcher = null;

  if (!brokerManager.isReady()) return;
  const broker = brokerManager.get();

  const settings = await loadSettings(db);

  orderService = new OrderService(db, broker, () => loadSettings(db));
  orderService.on('event', broadcast);

  watchlistWatcher = new WatchlistWatcher(broker, (payload) => {
    broadcastRaw('APP_EVENT', {
      id: randomUUID(),
      type: 'WATCHLIST_SIGNAL',
      activeId: payload.activeId,
      payload,
      createdAt: Date.now(),
    });
  });

  // A vigilancia de TODOS os ativos x TODAS as estrategias (WatchlistWatcher.setAssets) fica
  // DESLIGADA por enquanto — ligar automaticamente no login criou 101 assinaturas de velas ao
  // vivo de uma vez, e trocar de sessao (reconectar/logar de novo) com todas elas abertas
  // derrubou a conexao com a corretora (a troca de WebSocket no meio das 101 chamadas de
  // unsubscribe gerava uma enxurrada de "WebSocket is closing"). O login volta a nao disparar
  // nenhuma analise sozinho — so cria o watcher vazio, pronto pra ser ligado depois com cuidado.
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
 * Reconciliacao de ordens presas (UNKNOWN ou CONFIRMED) — pra cada uma com brokerOrderId
 * (ou seja, a corretora chegou a confirmar o pedido), tenta buscar o resultado real via
 * OrderService.reconcileStuckOrder (atualiza o registro, o resultado do dia e avisa o
 * cliente, sem nunca reenviar nem disparar Gale). Ordens sem brokerOrderId (a chamada de
 * rede falhou ANTES de qualquer confirmacao) ficam UNKNOWN permanentemente.
 *
 * Por que isso existe: o polling que espera o resultado (OrderService.pollForResolution) so
 * vive em memoria — um restart do processo (deploy, crash) no meio do caminho mata esse loop
 * e a ordem fica CONFIRMED pra sempre, sem resultado/PnL, mesmo que a corretora ja tenha
 * resolvido ha muito tempo. Chamada no boot do servidor E logo apos cada login (so entao
 * brokerManager.isReady() fica true em producao, ja que o processo sobe SEM sessao ate o
 * usuario logar).
 */
async function reconcileStuckOrders(): Promise<void> {
  if (!brokerManager.isReady() || !orderService) return; // sem sessao/servico ainda — nada a reconciliar agora
  const settings = await loadSettings(db);
  const [unknown, confirmed] = await Promise.all([listUnknownOrders(db), listConfirmedOrders(db)]);
  const stuck = [...unknown, ...confirmed].filter((o) => o.brokerOrderId);
  if (stuck.length === 0) return;
  console.log(`[reconcile] ${stuck.length} ordem(ns) presa(s) (UNKNOWN/CONFIRMED) com brokerOrderId — tentando reconciliar...`);
  for (const order of stuck) {
    try {
      const outcome = await orderService.reconcileStuckOrder(order, settings);
      if (outcome === 'resolved') console.log(`[reconcile] Ordem ${order.id} resolvida.`);
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
  ensureLiveServicesStarted()
    .then(() => reconcileStuckOrders())
    .catch((err) => console.error('[live] erro inesperado ao iniciar:', err));
});

process.on('SIGINT', async () => {
  liveMonitor?.stop();
  if (brokerManager.isReady()) await brokerManager.get().disconnect().catch(() => {});
  process.exit(0);
});
