import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Db } from '../db/db.js';
import { ENTRY_DIRECTION, type AppEvent, type Candle, type Settings } from '@polarium12c/shared';
import type { BrokerAdapter } from '../broker/BrokerAdapter.js';
import { evaluateSafety, type SafetyContext } from './SafetyGate.js';
import {
  getDailyResult,
  getOrderBySignalId,
  getSignal,
  hasPendingOrderForActive,
  insertEvent,
  insertOrderIfAbsent,
  saveDailyResult,
  saveSignal,
  updateOrder,
  updateSignalStatus,
} from '../db/repositories.js';

const MAX_SERVER_TIME_DRIFT_MS = 5000;
const EXPIRY_SECONDS = 60; // M1

export interface OrderServiceOptions {
  pollIntervalMs?: number;
  maxPollAttempts?: number;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Liga PATTERN_CONFIRMED (emitido pelo LiveMonitorService) ao BrokerAdapter, passando
 * SEMPRE pelo SafetyGate antes de qualquer chamada de rede. So opera em modo DEMO —
 * OBSERVATION nunca chama isto adiante, REAL e bloqueado pelo proprio SafetyGate.
 *
 * Ordem de operacoes ao confirmar um sinal (nessa sequencia, nunca invertida):
 *   1. Persistir o sinal (idempotente — se ja existe, para aqui).
 *   2. Coletar o contexto de seguranca (saldo, payout, horario do servidor, etc.).
 *   3. Rodar o SafetyGate. Se bloquear, registrar o motivo e parar — nenhuma chamada de
 *      rede de ordem e feita.
 *   4. Persistir a ORDEM (status REQUESTED) com protecao UNIQUE(signal_id) ANTES de
 *      chamar broker.placeOrder — assim, se a conexao cair exatamente durante a chamada,
 *      ja existe um registro para reconciliar/marcar como UNKNOWN, nunca reenviar.
 */
export class OrderService extends EventEmitter {
  private readonly pollIntervalMs: number;
  private readonly maxPollAttempts: number;

  constructor(
    private readonly db: Db,
    private readonly broker: BrokerAdapter,
    private readonly getSettings: () => Promise<Settings>,
    options: OrderServiceOptions = {}
  ) {
    super();
    this.pollIntervalMs = options.pollIntervalMs ?? 3000;
    this.maxPollAttempts = options.maxPollAttempts ?? 40;
  }

  /** Deve ser chamado quando o LiveMonitorService emitir um evento PATTERN_CONFIRMED. */
  async handleConfirmed(activeId: number, window: Candle[], wickPercentage11: number): Promise<void> {
    const lastPatternCandle = window[window.length - 1]; // hoje a 13a vela do padrao (sempre G)
    if (!lastPatternCandle) return;

    const signalId = `12CANDLES-${activeId}-${lastPatternCandle.to}-${ENTRY_DIRECTION}`;

    if (await getSignal(this.db, signalId)) return; // ja processado — idempotente por design

    await saveSignal(this.db, {
      id: signalId,
      activeId,
      direction: ENTRY_DIRECTION,
      createdAt: Date.now(),
      candles: window,
      wickPercentage11,
      status: 'CREATED',
    });

    const settings = await this.getSettings();
    const context = await this.buildSafetyContext(activeId, signalId, settings);
    const safety = evaluateSafety(context);

    if (!safety.allowed) {
      await updateSignalStatus(this.db, signalId, 'BLOCKED');
      this.emitEvent('BLOCKED_BY_SAFETY_CHECK', activeId, { signalId, blockedBy: safety.blockedBy });
      return;
    }

    const orderId = randomUUID();
    const { inserted } = await insertOrderIfAbsent(this.db, {
      id: orderId,
      signalId,
      activeId,
      direction: ENTRY_DIRECTION,
      amount: settings.entryAmount,
      status: 'REQUESTED',
      requestedAt: Date.now(),
      mode: settings.mode,
    });
    if (!inserted) return; // outra chamada concorrente ja criou a ordem para este sinal

    await updateSignalStatus(this.db, signalId, 'ORDER_REQUESTED');
    this.emitEvent('ORDER_REQUESTED', activeId, { signalId, orderId, amount: settings.entryAmount });

    try {
      const ack = await this.broker.placeOrder({
        activeId,
        direction: ENTRY_DIRECTION,
        amount: settings.entryAmount,
        expirySeconds: EXPIRY_SECONDS,
      });
      await updateOrder(this.db, orderId, { brokerOrderId: ack.brokerOrderId, status: 'CONFIRMED', confirmedAt: Date.now() });
      await updateSignalStatus(this.db, signalId, 'ORDER_CONFIRMED');
      this.emitEvent('ORDER_CONFIRMED', activeId, { signalId, orderId, brokerOrderId: ack.brokerOrderId });

      this.pollForResolution(orderId, ack.brokerOrderId, activeId, signalId, settings).catch((err) =>
        this.emitEvent('BLOCKED_BY_SAFETY_CHECK', activeId, { signalId, orderId, pollError: String(err) })
      );
    } catch (err) {
      // Perdeu a conexao (ou a corretora rejeitou) DEPOIS de persistir a ordem, ANTES de
      // confirmar. Regra: nunca reenviar. Fica UNKNOWN ate reconciliacao manual/automatica.
      await updateOrder(this.db, orderId, { status: 'UNKNOWN' });
      await updateSignalStatus(this.db, signalId, 'ORDER_UNKNOWN');
      this.emitEvent('ORDER_UNKNOWN', activeId, { signalId, orderId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private async buildSafetyContext(activeId: number, signalId: string, settings: Settings): Promise<SafetyContext> {
    let connectionHealthy = false;
    let sessionValid = false;
    let serverTimeDriftMs: number | null = null;
    try {
      const before = Date.now();
      const serverTime = await this.broker.getServerTime();
      connectionHealthy = true;
      sessionValid = true;
      serverTimeDriftMs = serverTime.getTime() - before;
    } catch {
      // conexao/sessao desconhecida — os campos ja ficam false/null, o gate bloqueia.
    }

    let balance: number | null = null;
    try {
      const balances = await this.broker.getBalances();
      balance = balances[0]?.amount ?? null;
    } catch {
      balance = null;
    }

    let payoutPercentage: number | null = null;
    try {
      payoutPercentage = await this.broker.getPayout(activeId, settings.entryAmount);
    } catch {
      payoutPercentage = null;
    }

    return {
      mode: settings.mode,
      robotActive: settings.robotActive,
      connectionHealthy,
      sessionValid,
      serverTimeDriftMs,
      maxServerTimeDriftMs: MAX_SERVER_TIME_DRIFT_MS,
      balance,
      payoutPercentage,
      entryAmount: settings.entryAmount,
      stopWinDaily: settings.stopWinDaily,
      stopLossDaily: settings.stopLossDaily,
      maxOperationsPerDay: settings.maxOperationsPerDay,
      dailyResult: await getDailyResult(this.db, todayIso()),
      hasPendingOrderForActive: await hasPendingOrderForActive(this.db, activeId),
      orderAlreadyExistsForSignal: (await getOrderBySignalId(this.db, signalId)) !== undefined,
    };
  }

  private async pollForResolution(
    orderId: string,
    brokerOrderId: string,
    activeId: number,
    signalId: string,
    settings: Settings
  ): Promise<void> {
    for (let attempt = 0; attempt < this.maxPollAttempts; attempt++) {
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));

      let resolution;
      try {
        resolution = await this.broker.getOrderResult(brokerOrderId);
      } catch {
        continue; // erro transitorio — tenta de novo, nao desiste na primeira falha
      }

      if (!resolution) continue; // ainda nao fechou

      await updateOrder(this.db, orderId, {
        status: 'FILLED',
        resolvedAt: Date.now(),
        result: resolution.result,
        pnl: resolution.pnl,
        payoutPercentage: resolution.payoutPercentage,
      });
      await updateSignalStatus(this.db, signalId, resolution.result);
      this.emitEvent(resolution.result, activeId, { signalId, orderId, pnl: resolution.pnl });

      await this.applyToDailyResult(activeId, resolution.result, resolution.pnl, settings);
      return;
    }
    // Esgotou as tentativas sem resolucao: a ordem fica CONFIRMED (nao UNKNOWN — sabemos
    // que foi aceita, so nao confirmamos o resultado ainda). Reconciliacao manual depois.
  }

  private async applyToDailyResult(activeId: number, result: 'WIN' | 'LOSS' | 'DOJI', pnl: number, settings: Settings): Promise<void> {
    const date = todayIso();
    const current = await getDailyResult(this.db, date);
    const next = {
      ...current,
      wins: current.wins + (result === 'WIN' ? 1 : 0),
      losses: current.losses + (result === 'LOSS' ? 1 : 0),
      dojis: current.dojis + (result === 'DOJI' ? 1 : 0),
      pnl: current.pnl + pnl,
      operationsCount: current.operationsCount + 1,
    };

    if (settings.stopWinDaily !== null && next.pnl >= settings.stopWinDaily && !next.stopWinHit) {
      next.stopWinHit = true;
      this.emitEvent('STOP_WIN', activeId, { pnl: next.pnl, stopWinDaily: settings.stopWinDaily });
    }
    if (settings.stopLossDaily !== null && next.pnl <= -settings.stopLossDaily && !next.stopLossHit) {
      next.stopLossHit = true;
      this.emitEvent('STOP_LOSS', activeId, { pnl: next.pnl, stopLossDaily: settings.stopLossDaily });
    }

    await saveDailyResult(this.db, next);
  }

  private emitEvent(type: AppEvent['type'], activeId: number, payload: Record<string, unknown>): void {
    const event: AppEvent = { id: randomUUID(), type, activeId, payload, createdAt: Date.now() };
    insertEvent(this.db, event).catch((err) => console.error('[orders] falha ao persistir evento:', err));
    this.emit('event', event);
  }
}
