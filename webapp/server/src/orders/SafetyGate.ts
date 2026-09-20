import type { AppMode, DailyResult } from '@polarium12c/shared';

/**
 * Checklist de seguranca obrigatorio antes de QUALQUER ordem. Regra principal: NA DUVIDA,
 * NAO OPERAR — qualquer campo desconhecido (null) bloqueia, nunca assume um valor "seguro"
 * por omissao.
 *
 * Funcao pura e sincrona de proposito: nao faz nenhuma chamada de rede/banco, so avalia um
 * contexto ja coletado. Isso permite testar cada regra isoladamente sem broker/DB reais.
 */
export interface SafetyContext {
  mode: AppMode;
  robotActive: boolean;
  connectionHealthy: boolean;
  sessionValid: boolean;
  /** Diferenca (ms) entre o horario do servidor da corretora e o relogio local. null = desconhecido. */
  serverTimeDriftMs: number | null;
  maxServerTimeDriftMs: number;
  balance: number | null;
  /** Payout real da corretora (fracao, ex.: 0.85). null = desconhecido — nunca inventado. */
  payoutPercentage: number | null;
  entryAmount: number;
  stopWinDaily: number | null;
  stopLossDaily: number | null;
  maxOperationsPerDay: number | null;
  dailyResult: DailyResult;
  /** True se ja existe uma ordem em aberto (nao resolvida) para o MESMO ativo. */
  hasPendingOrderForActive: boolean;
  /** True se ja existe uma ordem para este signalId (protecao contra duplicidade). */
  orderAlreadyExistsForSignal: boolean;
}

export type SafetyBlockReason =
  | 'DUPLICATE_SIGNAL'
  | 'MODE_NOT_DEMO'
  | 'ROBOT_STOPPED'
  | 'CONNECTION_UNHEALTHY'
  | 'SESSION_INVALID'
  | 'TIME_NOT_SYNCED'
  | 'BALANCE_UNKNOWN'
  | 'PAYOUT_UNKNOWN'
  | 'INVALID_AMOUNT'
  | 'INSUFFICIENT_BALANCE'
  | 'STOP_WIN_REACHED'
  | 'STOP_LOSS_REACHED'
  | 'MAX_OPERATIONS_REACHED'
  | 'PENDING_ORDER_EXISTS';

export interface SafetyResult {
  allowed: boolean;
  blockedBy: SafetyBlockReason[];
}

export function evaluateSafety(ctx: SafetyContext): SafetyResult {
  const blockedBy: SafetyBlockReason[] = [];

  if (ctx.orderAlreadyExistsForSignal) blockedBy.push('DUPLICATE_SIGNAL');

  // REAL nunca opera nesta versao; OBSERVATION so detecta/registra por definicao.
  if (ctx.mode !== 'DEMO') blockedBy.push('MODE_NOT_DEMO');

  if (!ctx.robotActive) blockedBy.push('ROBOT_STOPPED');
  if (!ctx.connectionHealthy) blockedBy.push('CONNECTION_UNHEALTHY');
  if (!ctx.sessionValid) blockedBy.push('SESSION_INVALID');

  if (ctx.serverTimeDriftMs === null || Math.abs(ctx.serverTimeDriftMs) > ctx.maxServerTimeDriftMs) {
    blockedBy.push('TIME_NOT_SYNCED');
  }

  if (ctx.balance === null) blockedBy.push('BALANCE_UNKNOWN');
  if (ctx.payoutPercentage === null) blockedBy.push('PAYOUT_UNKNOWN');

  if (!Number.isFinite(ctx.entryAmount) || ctx.entryAmount < 5) blockedBy.push('INVALID_AMOUNT');
  if (ctx.balance !== null && ctx.entryAmount > ctx.balance) blockedBy.push('INSUFFICIENT_BALANCE');

  if (ctx.stopWinDaily !== null && ctx.dailyResult.pnl >= ctx.stopWinDaily) blockedBy.push('STOP_WIN_REACHED');
  if (ctx.stopLossDaily !== null && ctx.dailyResult.pnl <= -ctx.stopLossDaily) blockedBy.push('STOP_LOSS_REACHED');
  if (ctx.maxOperationsPerDay !== null && ctx.dailyResult.operationsCount >= ctx.maxOperationsPerDay) {
    blockedBy.push('MAX_OPERATIONS_REACHED');
  }

  if (ctx.hasPendingOrderForActive) blockedBy.push('PENDING_ORDER_EXISTS');

  return { allowed: blockedBy.length === 0, blockedBy };
}
