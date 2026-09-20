import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { OrderRecord, Signal } from '@polarium12c/shared';
import { getTestDb, resetDb } from './helpers/testDb.js';
import { insertOrderIfAbsent, saveSignal } from '../src/db/repositories.js';
import type { Db } from '../src/db/db.js';

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
  let db: Db;

  beforeEach(async () => {
    db = await getTestDb();
    await resetDb(db);
  });

  afterAll(async () => {
    await db.end();
  });

  it('garante no maximo UMA ordem por signalId, mesmo com tentativas concorrentes/repetidas', async () => {
    const signalId = '12CANDLES-81-1800000720-CALL';
    await saveSignal(db, mkSignal(signalId));

    const first = await insertOrderIfAbsent(db, mkOrder(signalId, 'order-1'));
    expect(first.inserted).toBe(true);
    expect(first.order.id).toBe('order-1');

    // Uma segunda tentativa de criar ordem para o MESMO sinal (ex.: reconexao, retry apos
    // timeout, duplo clique) nao deve criar uma segunda ordem.
    const second = await insertOrderIfAbsent(db, mkOrder(signalId, 'order-2'));
    expect(second.inserted).toBe(false);
    expect(second.order.id).toBe('order-1'); // continua sendo a ordem original

    const { rows } = await db.query('SELECT COUNT(*) as n FROM orders WHERE signal_id = $1', [signalId]);
    expect(Number(rows[0].n)).toBe(1);
  });

  it('o unique constraint do banco tambem barra insercao direta duplicada (sobrevive a reinicio da aplicacao, ja que o Postgres persiste de verdade entre processos)', async () => {
    const signalId = '12CANDLES-81-1800000780-CALL';
    await saveSignal(db, mkSignal(signalId));
    await insertOrderIfAbsent(db, mkOrder(signalId, 'order-1'));

    // O ponto testado e que o UNIQUE(signal_id) do schema.sql protege mesmo se o codigo da
    // aplicacao tentasse inserir direto, sem passar por insertOrderIfAbsent.
    await expect(
      db.query(
        `INSERT INTO orders (id, signal_id, active_id, direction, amount, status, requested_at, mode)
         VALUES ('order-3', $1, 81, 'CALL', 5, 'REQUESTED', $2, 'DEMO')`,
        [signalId, Date.now()]
      )
    ).rejects.toThrow();
  });
});
