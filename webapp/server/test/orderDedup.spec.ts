import { describe, expect, it } from 'vitest';
import type { OrderRecord, Signal } from '@polarium12c/shared';
import { openDb } from '../src/db/db.js';
import { insertOrderIfAbsent, saveSignal } from '../src/db/repositories.js';

function mkSignal(id: string): Signal {
  return {
    id,
    activeId: 81,
    direction: 'CALL',
    createdAt: Date.now(),
    candles: [],
    wickPercentage11: 0.5,
    status: 'CREATED',
  };
}

function mkOrder(signalId: string, id: string): OrderRecord {
  return {
    id,
    signalId,
    activeId: 81,
    direction: 'CALL',
    amount: 5,
    status: 'REQUESTED',
    requestedAt: Date.now(),
    mode: 'DEMO',
  };
}

describe('protecao contra ordem duplicada (persistida em banco)', () => {
  it('garante no maximo UMA ordem por signalId, mesmo com tentativas concorrentes/repetidas', () => {
    const db = openDb(':memory:');
    const signalId = '12CANDLES-81-1800000720-CALL';
    saveSignal(db, mkSignal(signalId));

    const first = insertOrderIfAbsent(db, mkOrder(signalId, 'order-1'));
    expect(first.inserted).toBe(true);
    expect(first.order.id).toBe('order-1');

    // Uma segunda tentativa de criar ordem para o MESMO sinal (ex.: reconexao, retry apos
    // timeout, duplo clique) nao deve criar uma segunda ordem.
    const second = insertOrderIfAbsent(db, mkOrder(signalId, 'order-2'));
    expect(second.inserted).toBe(false);
    expect(second.order.id).toBe('order-1'); // continua sendo a ordem original

    const rows = db.prepare('SELECT COUNT(*) as n FROM orders WHERE signal_id = ?').get(signalId) as { n: number };
    expect(rows.n).toBe(1);
  });

  it('sobrevive a reinicio da aplicacao: o unique constraint do banco tambem barra insercao direta duplicada', () => {
    const db = openDb(':memory:');
    const signalId = '12CANDLES-81-1800000780-CALL';
    saveSignal(db, mkSignal(signalId));
    insertOrderIfAbsent(db, mkOrder(signalId, 'order-1'));

    // Simula "reinicio": abre uma nova conexao ao MESMO arquivo nao se aplica aqui (":memory:"
    // e por processo), mas o ponto testado e que o UNIQUE(signal_id) do schema.sql protege
    // mesmo se o codigo de aplicacao tentasse inserir direto sem passar por insertOrderIfAbsent.
    expect(() => {
      db.prepare(
        `INSERT INTO orders (id, signal_id, active_id, direction, amount, status, requested_at, mode)
         VALUES ('order-3', ?, 81, 'CALL', 5, 'REQUESTED', ?, 'DEMO')`
      ).run(signalId, Date.now());
    }).toThrow();
  });
});
