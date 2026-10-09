import 'dotenv/config';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface DB {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: DB) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
export async function connectDatabase(
  options: { memory?: boolean; url?: string } = {},
): Promise<DB> {
  const url = options.url ?? process.env.DATABASE_URL;
  if (url && !options.memory) {
    const pool = new pg.Pool({ connectionString: url, max: 10 });
    const wrap = (client: pg.Pool | pg.PoolClient): DB => ({
      query: async (sql, params) => (await client.query(sql, params)).rows,
      exec: async (sql) => {
        await client.query(sql);
      },
      transaction: async (fn) => {
        const connection = await pool.connect();
        try {
          await connection.query('BEGIN');
          const result = await fn(wrap(connection));
          await connection.query('COMMIT');
          return result;
        } catch (e) {
          await connection.query('ROLLBACK');
          throw e;
        } finally {
          connection.release();
        }
      },
      close: async () => {
        await pool.end();
      },
    });
    return wrap(pool);
  }
  if (process.env.NODE_ENV === 'production' && !options.memory)
    throw new Error('Production requires DATABASE_URL. PGlite is for local development only.');
  const path = resolve(process.env.PGLITE_PATH || '.data/agentspace');
  if (!options.memory) await mkdir(path, { recursive: true });
  const pglite = new PGlite(options.memory ? undefined : path);
  const wrap = (client: Pick<PGlite, 'query' | 'exec'>): DB => ({
    query: async <T>(sql: string, params?: unknown[]) => (await client.query<T>(sql, params)).rows,
    exec: async (sql) => {
      await client.exec(sql);
    },
    transaction: (fn) => pglite.transaction(async (tx) => fn(wrap(tx))),
    close: () => pglite.close(),
  });
  await pglite.waitReady;
  return wrap(pglite);
}
export async function migrate(db: DB) {
  await db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const directory = new URL('./migrations/', import.meta.url);
  for (const file of (await readdir(directory)).filter((f) => f.endsWith('.sql')).sort()) {
    if ((await db.query('SELECT name FROM schema_migrations WHERE name=$1', [file])).length)
      continue;
    const sql = await readFile(new URL(file, directory), 'utf8');
    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations(name) VALUES($1)', [file]);
    });
  }
}
