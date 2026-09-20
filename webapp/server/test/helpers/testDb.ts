import 'dotenv/config';
import { openDb, type Db } from '../../src/db/db.js';

/**
 * Os testes rodam contra o MESMO banco Postgres (Supabase) usado em dev/producao — nao ha
 * um modo ":memory:" equivalente para Postgres. Por isso:
 *  - vitest.config.ts desliga o paralelismo entre arquivos (fileParallelism: false), para
 *    nao haver dois arquivos de teste truncando as mesmas tabelas ao mesmo tempo.
 *  - cada teste limpa as tabelas relevantes antes de rodar (ver resetDb), garantindo o
 *    mesmo isolamento que o antigo `openDb(':memory:')` dava.
 */

let pool: Db | null = null;

export async function getTestDb(): Promise<Db> {
  if (!pool) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        'DATABASE_URL nao configurado. Crie webapp/server/.env com a connection string do Postgres (Supabase) para rodar os testes.'
      );
    }
    pool = await openDb(url);
  }
  return pool;
}

export async function resetDb(db: Db): Promise<void> {
  await db.query(
    'TRUNCATE candles, signals, orders, backtest_occurrences, backtests, settings, daily_results, events CASCADE'
  );
}
