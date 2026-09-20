import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const { Pool } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));

export type Db = pg.Pool;

/**
 * Abre um pool de conexoes Postgres (Supabase) e garante que o schema existe
 * (CREATE TABLE IF NOT EXISTS — idempotente, seguro rodar toda vez que o processo sobe).
 *
 * connectionString: normalmente vem de DATABASE_URL (a "Connection string" do painel do
 * Supabase — Project Settings > Database). Nunca fica fixa no codigo.
 */
export async function openDb(connectionString: string): Promise<Db> {
  const pool = new Pool({
    connectionString,
    // Supabase exige TLS para conexoes externas; o certificado da Supabase e valido, mas
    // muitos ambientes (Render incluso) nao tem a CA raiz deles na cadeia local de
    // confianca por padrao, entao relaxamos a verificacao da cadeia sem desligar o TLS em
    // si (a conexao continua criptografada).
    ssl: { rejectUnauthorized: false },
  });

  const schema = readFileSync(join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);

  return pool;
}
