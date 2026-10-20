import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Db } from '../db/db.js';
import type { AppEvent, Candle, Direction, Settings } from '@polarium12c/shared';
import type { BrokerAdapter } from '../broker/BrokerAdapter.js';
import { evaluateSafety, type SafetyBlockReason, type SafetyContext } from './SafetyGate.js';
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

export interface PlaceOrderOutcome {
  allowed: boolean;
  blockedBy: SafetyBlockReason[];
  signalId: string;
  amount: number;
  /** Payout usado na checagem de seguranca desta entrada (fracao, ex.: 0.85) — null se bloqueada antes de ser conhecido. */
  payoutPercentage: number | null;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Liga confirmacoes de sinal (automaticas, via PATTERN_CONFIRMED do LiveMonitorService, OU
 * manuais, via placeManualOrder) ao BrokerAdapter, passando SEMPRE pelo SafetyGate antes de
 * qualquer chamada de rede. DEMO e REAL operam pelas MESMAS regras — a diferenca de dinheiro
 * de verdade fica inteiramente por conta de qual sessao/credencial o BrokerAdapter usa.
 * OBSERVATION nunca chega a enviar nada (bloqueado pelo proprio SafetyGate).
 *
 * Ordem de operacoes ao confirmar um sinal (nessa sequencia, nunca invertida):
 *   1. Persistir o sinal (idempotente — se ja existe, para aqui).
 *   2. Coletar o contexto de seguranca (saldo, payout, horario do servidor, etc.).
 *   3. Rodar o SafetyGate. Se bloquear, registrar o motivo e parar — nenhuma chamada de
 *      rede de ordem e feita.
 *   4. Persistir a ORDEM (status REQUESTED) com protecao UNIQUE(signal_id) ANTES de
 *      chamar broker.placeOrder — assim, se a conexao cair exatamente durante a chamada,
 *      ja existe um registro para reconciliar/marcar como UNKNOWN, nunca reenviar.
 *
 * Gale (reentrada apos LOSS): quando settings.galeEnabled e o nivel atual ainda nao atingiu
 * settings.galeMaxLevels, uma LOSS dispara automaticamente a proxima entrada, MESMA direcao,
 * valor DOBRADO — ver pollForResolution. Cada nivel e uma ordem de verdade, independente,
 * passando pelo MESMO SafetyGate (ex.: se o Stop Loss diario ja foi atingido pela perda que
 * disparou o Gale, a reentrada tambem e bloqueada, nunca "pula" a regra).
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
  async handleConfirmed(activeId: number, window: Candle[], wickPercentage11: number, direction: Direction): Promise<void> {
    const lastPatternCandle = window[window.length - 1]; // ultima vela do prefixo do padrao ativo
    if (!lastPatternCandle) return;

    const signalId = `12CANDLES-${activeId}-${lastPatternCandle.to}-${direction}`;
    if (await getSignal(this.db, signalId)) return; // ja processado — idempotente por design

    await saveSignal(this.db, {
      id: signalId,
      activeId,
      direction,
      createdAt: Date.now(),
      candles: window,
      wickPercentage11,
      status: 'CREATED',
    });

    const settings = await this.getSettings();
    await this.executeOrder(signalId, signalId, activeId, direction, settings.entryAmount, 0, settings, false);
  }

  /**
   * Entrada MANUAL — clique do usuario nos botoes Comprar/Vender da tela do grafico. Mesmo
   * caminho de seguranca de `handleConfirmed`, so que sem um padrao de 12 velas por tras (o
   * sinal criado aqui nao tem pattern_json real, so serve pra satisfazer a FK de orders).
   * Devolve o resultado (permitido ou os motivos do bloqueio) pra UI poder explicar ao
   * usuario por que a ordem nao saiu, em vez de so falhar silenciosamente.
   */
  async placeManualOrder(activeId: number, direction: Direction): Promise<PlaceOrderOutcome> {
    const signalId = `MANUAL-${activeId}-${direction}-${Date.now()}-${randomUUID().slice(0, 8)}`;
    await saveSignal(this.db, {
      id: signalId,
      activeId,
      direction,
      createdAt: Date.now(),
      candles: [],
      wickPercentage11: 0,
      status: 'CREATED',
    });

    const settings = await this.getSettings();
    const { blockedBy, payoutPercentage } = await this.executeOrder(
      signalId,
      signalId,
      activeId,
      direction,
      settings.entryAmount,
      0,
      settings,
      true
    );
    return { allowed: blockedBy.length === 0, blockedBy, signalId, amount: settings.entryAmount, payoutPercentage };
  }

  /**
   * Nucleo compartilhado: roda o SafetyGate e, se permitido, persiste + envia a ordem pra
   * corretora. Retorna a lista de motivos de bloqueio (vazia = foi enviada). `rootSignalId`
   * e o signalId da entrada ORIGINAL (nivel 0) — em reentradas de Gale, liga de volta pra ela
   * mesmo que o signalId desta chamada especifica seja outro (um por nivel, exigido pela FK).
   */
  private async executeOrder(
    signalId: string,
    rootSignalId: string,
    activeId: number,
    direction: Direction,
    amount: number,
    galeLevel: number,
    settings: Settings,
    isManualOrder: boolean
  ): Promise<{ blockedBy: SafetyBlockReason[]; payoutPercentage: number | null }> {
    const context = await this.buildSafetyContext(activeId, signalId, amount, settings, isManualOrder);
    const safety = evaluateSafety(context);

    if (!safety.allowed) {
      await updateSignalStatus(this.db, signalId, 'BLOCKED');
      this.emitEvent('BLOCKED_BY_SAFETY_CHECK', activeId, { signalId, galeLevel, blockedBy: safety.blockedBy });
      return { blockedBy: safety.blockedBy, payoutPercentage: context.payoutPercentage };
    }

    const orderId = randomUUID();
    const { inserted } = await insertOrderIfAbsent(this.db, {
      id: orderId,
      signalId,
      rootSignalId,
      galeLevel,
      activeId,
      direction,
      amount,
      status: 'REQUESTED',
      requestedAt: Date.now(),
      mode: settings.mode,
    });
    if (!inserted) return { blockedBy: [], payoutPercentage: context.payoutPercentage }; // outra chamada concorrente ja criou a ordem para este sinal

    await updateSignalStatus(this.db, signalId, 'ORDER_REQUESTED');
    this.emitEvent('ORDER_REQUESTED', activeId, { signalId, orderId, amount, galeLevel });

    try {
      const ack = await this.broker.placeOrder({ activeId, direction, amount, expirySeconds: EXPIRY_SECONDS, mode: settings.mode });
      await updateOrder(this.db, orderId, { brokerOrderId: ack.brokerOrderId, status: 'CONFIRMED', confirmedAt: Date.now() });
      await updateSignalStatus(this.db, signalId, 'ORDER_CONFIRMED');
      this.emitEvent('ORDER_CONFIRMED', activeId, { signalId, orderId, brokerOrderId: ack.brokerOrderId, galeLevel });

      this.pollForResolution(
        orderId,
        ack.brokerOrderId,
        activeId,
        signalId,
        rootSignalId,
        direction,
        amount,
        galeLevel,
        settings,
        isManualOrder
      ).catch((err) => this.emitEvent('BLOCKED_BY_SAFETY_CHECK', activeId, { signalId, orderId, pollError: String(err) }));
    } catch (err) {
      // Perdeu a conexao (ou a corretora rejeitou) DEPOIS de persistir a ordem, ANTES de
      // confirmar. Regra: nunca reenviar. Fica UNKNOWN ate reconciliacao manual/automatica.
      await updateOrder(this.db, orderId, { status: 'UNKNOWN' });
      await updateSignalStatus(this.db, signalId, 'ORDER_UNKNOWN');
      this.emitEvent('ORDER_UNKNOWN', activeId, { signalId, orderId, error: err instanceof Error ? err.message : String(err) });
    }
    return { blockedBy: [], payoutPercentage: context.payoutPercentage };
  }

  private async buildSafetyContext(
    activeId: number,
    signalId: string,
    entryAmount: number,
    settings: Settings,
    isManualOrder: boolean
  ): Promise<SafetyContext> {
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
      // Tem que ser o saldo do MODO ATIVO (demo/real), nunca so "o primeiro que veio" — senao
      // o INSUFFICIENT_BALANCE podia estar checando a conta errada (mesmo bug corrigido no
      // cabecalho do cliente, aqui no lado que realmente decide se opera ou nao).
      const wantedType = settings.mode === 'REAL' ? 'real' : 'demo';
      balance = balances.find((b) => b.type === wantedType)?.amount ?? null;
    } catch {
      balance = null;
    }

    let payoutPercentage: number | null = null;
    try {
      payoutPercentage = await this.broker.getPayout(activeId, entryAmount);
    } catch (err) {
      console.error(`[orders] getPayout(${activeId}, ${entryAmount}) lancou erro — bloqueando por PAYOUT_UNKNOWN:`, err);
      payoutPercentage = null;
    }

    return {
      mode: settings.mode,
      robotActive: settings.robotActive,
      isManualOrder,
      connectionHealthy,
      sessionValid,
      serverTimeDriftMs,
      maxServerTimeDriftMs: MAX_SERVER_TIME_DRIFT_MS,
      balance,
      payoutPercentage,
      entryAmount,
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
    rootSignalId: string,
    direction: Direction,
    amount: number,
    galeLevel: number,
    settings: Settings,
    isManualOrder: boolean
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
      this.emitEvent(resolution.result, activeId, { signalId, orderId, pnl: resolution.pnl, galeLevel });

      await this.applyToDailyResult(activeId, resolution.result, resolution.pnl, settings);

      if (resolution.result === 'LOSS' && settings.galeEnabled && galeLevel < settings.galeMaxLevels) {
        const nextLevel = galeLevel + 1;
        const nextSignalId = `${rootSignalId}-GALE${nextLevel}`;
        const nextAmount = amount * 2; // martingale classico: dobra sobre a entrada QUE ACABOU de perder
        await saveSignal(this.db, {
          id: nextSignalId,
          activeId,
          direction,
          createdAt: Date.now(),
          candles: [],
          wickPercentage11: 0,
          status: 'CREATED',
        });
        await this.executeOrder(nextSignalId, rootSignalId, activeId, direction, nextAmount, nextLevel, settings, isManualOrder);
      }
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
