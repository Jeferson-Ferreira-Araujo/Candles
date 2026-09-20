import { describe, expect, it } from 'vitest';
import type { DailyResult } from '@polarium12c/shared';
import { evaluateSafety, type SafetyContext } from '../src/orders/SafetyGate.js';

function baseContext(overrides: Partial<SafetyContext> = {}): SafetyContext {
  const dailyResult: DailyResult = {
    date: '2026-09-20',
    wins: 0,
    losses: 0,
    dojis: 0,
    pnl: 0,
    operationsCount: 0,
    stopWinHit: false,
    stopLossHit: false,
  };

  return {
    mode: 'DEMO',
    robotActive: true,
    connectionHealthy: true,
    sessionValid: true,
    serverTimeDriftMs: 100,
    maxServerTimeDriftMs: 5000,
    balance: 1000,
    payoutPercentage: 0.85,
    entryAmount: 5,
    stopWinDaily: null,
    stopLossDaily: null,
    maxOperationsPerDay: null,
    dailyResult,
    hasPendingOrderForActive: false,
    orderAlreadyExistsForSignal: false,
    ...overrides,
  };
}

describe('SafetyGate — na duvida, nao operar', () => {
  it('permite quando tudo esta ok', () => {
    const result = evaluateSafety(baseContext());
    expect(result.allowed).toBe(true);
    expect(result.blockedBy).toEqual([]);
  });

  it('bloqueia em modo OBSERVATION', () => {
    const result = evaluateSafety(baseContext({ mode: 'OBSERVATION' }));
    expect(result.allowed).toBe(false);
    expect(result.blockedBy).toContain('MODE_NOT_DEMO');
  });

  it('bloqueia em modo REAL (nunca opera nesta versao, mesmo se tudo mais estiver ok)', () => {
    const result = evaluateSafety(baseContext({ mode: 'REAL' }));
    expect(result.allowed).toBe(false);
    expect(result.blockedBy).toContain('MODE_NOT_DEMO');
  });

  it('bloqueia quando o robo esta parado (kill switch)', () => {
    const result = evaluateSafety(baseContext({ robotActive: false }));
    expect(result.blockedBy).toContain('ROBOT_STOPPED');
  });

  it('bloqueia quando a conexao esta desconhecida/ruim', () => {
    const result = evaluateSafety(baseContext({ connectionHealthy: false }));
    expect(result.blockedBy).toContain('CONNECTION_UNHEALTHY');
  });

  it('bloqueia quando o horario do servidor e desconhecido (null)', () => {
    const result = evaluateSafety(baseContext({ serverTimeDriftMs: null }));
    expect(result.blockedBy).toContain('TIME_NOT_SYNCED');
  });

  it('bloqueia quando o horario do servidor esta fora da tolerancia', () => {
    const result = evaluateSafety(baseContext({ serverTimeDriftMs: 999_999, maxServerTimeDriftMs: 5000 }));
    expect(result.blockedBy).toContain('TIME_NOT_SYNCED');
  });

  it('bloqueia quando o saldo e desconhecido', () => {
    const result = evaluateSafety(baseContext({ balance: null }));
    expect(result.blockedBy).toContain('BALANCE_UNKNOWN');
  });

  it('bloqueia quando o payout e desconhecido (nunca inventa payout)', () => {
    const result = evaluateSafety(baseContext({ payoutPercentage: null }));
    expect(result.blockedBy).toContain('PAYOUT_UNKNOWN');
  });

  it('bloqueia valor de entrada abaixo do minimo (R$5)', () => {
    const result = evaluateSafety(baseContext({ entryAmount: 4.99 }));
    expect(result.blockedBy).toContain('INVALID_AMOUNT');
  });

  it('bloqueia quando o valor de entrada excede o saldo', () => {
    const result = evaluateSafety(baseContext({ entryAmount: 50, balance: 10 }));
    expect(result.blockedBy).toContain('INSUFFICIENT_BALANCE');
  });

  it('Stop Win: bloqueia quando o resultado do dia ja atingiu o limite', () => {
    const result = evaluateSafety(
      baseContext({ stopWinDaily: 100, dailyResult: { ...baseContext().dailyResult, pnl: 100 } })
    );
    expect(result.blockedBy).toContain('STOP_WIN_REACHED');
  });

  it('Stop Loss: bloqueia quando o resultado do dia ja atingiu o limite negativo', () => {
    const result = evaluateSafety(
      baseContext({ stopLossDaily: 50, dailyResult: { ...baseContext().dailyResult, pnl: -50 } })
    );
    expect(result.blockedBy).toContain('STOP_LOSS_REACHED');
  });

  it('bloqueia ao atingir o maximo de operacoes por dia', () => {
    const result = evaluateSafety(
      baseContext({ maxOperationsPerDay: 20, dailyResult: { ...baseContext().dailyResult, operationsCount: 20 } })
    );
    expect(result.blockedBy).toContain('MAX_OPERATIONS_REACHED');
  });

  it('bloqueia quando ja existe ordem pendente para o mesmo ativo', () => {
    const result = evaluateSafety(baseContext({ hasPendingOrderForActive: true }));
    expect(result.blockedBy).toContain('PENDING_ORDER_EXISTS');
  });

  it('bloqueia sinal duplicado (ordem ja existe para este signalId)', () => {
    const result = evaluateSafety(baseContext({ orderAlreadyExistsForSignal: true }));
    expect(result.blockedBy).toContain('DUPLICATE_SIGNAL');
  });

  it('acumula todos os motivos de bloqueio simultaneamente, nao so o primeiro', () => {
    const result = evaluateSafety(baseContext({ robotActive: false, balance: null, connectionHealthy: false }));
    expect(result.blockedBy).toEqual(expect.arrayContaining(['ROBOT_STOPPED', 'BALANCE_UNKNOWN', 'CONNECTION_UNHEALTHY']));
  });
});
