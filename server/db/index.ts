import 'dotenv/config';
import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface DB {
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  transaction<T>(fn: (tx: DB) => Promise<T>): Promise<T>;
  /**
   * A consistent read-only snapshot (REPEATABLE READ). Served by the read replica when
   * DATABASE_READ_URL is set and the replica has replayed everything committed on the primary
   * before this call (read-your-writes); otherwise it runs on the primary.
   */
  readOnly<T>(fn: (tx: DB) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
/** Where readOnly() calls were served; exposed on /api/health for operations and load tests. */
export const readStats = { replica: 0, primary: 0, fallback: 0 };

export async function connectDatabase(
  options: { memory?: boolean; url?: string; readUrl?: string } = {},
): Promise<DB> {
  const url = options.url ?? process.env.DATABASE_URL;
  if (url && !options.memory) {
    const max = Number(process.env.DATABASE_POOL_MAX) || 10;
    const pool = new pg.Pool({ connectionString: url, max });
    const readUrl = options.readUrl ?? process.env.DATABASE_READ_URL;
    const replica = readUrl ? new pg.Pool({ connectionString: readUrl, max }) : undefined;
    async function run<T>(p: pg.Pool, begin: string, fn: (tx: DB) => Promise<T>, check?: string) {
      const connection = await p.connect();
      try {
        await connection.query(begin);
        if (check) {
          const [{ fresh }] = (
            await connection.query('SELECT pg_last_wal_replay_lsn() >= $1::pg_lsn AS fresh', [
              check,
            ])
          ).rows;
          if (!fresh) {
            await connection.query('ROLLBACK');
            return undefined;
          }
        }
        const result = await fn(wrap(connection));
        await connection.query('COMMIT');
        return { result };
      } catch (e) {
        await connection.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        connection.release();
      }
    }
    const READ = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
    const wrap = (client: pg.Pool | pg.PoolClient): DB => ({
      query: async (sql, params) => (await client.query(sql, params)).rows,
      exec: async (sql) => {
        await client.query(sql);
      },
      transaction: async (fn) => (await run(pool, 'BEGIN', fn))!.result,
      readOnly: async (fn) => {
        // Already inside a transaction: stay on that connection.
        if (client !== pool) return fn(wrap(client));
        if (replica) {
          try {
            const [{ lsn }] = (await pool.query('SELECT pg_current_wal_lsn()::text AS lsn')).rows;
            const served = await run(replica, READ, fn, lsn);
            if (served) {
              readStats.replica++;
              return served.result;
            }
            readStats.fallback++;
          } catch (e) {
            // A replica outage must not take reads down: fall back to the primary.
            if (
              (e as any)?.code &&
              !String((e as any).code).startsWith('08') &&
              (e as any).code !== '57P01'
            )
              throw e;
            readStats.fallback++;
          }
        }
        readStats.primary++;
        return (await run(pool, READ, fn))!.result;
      },
      close: async () => {
        await pool.end();
        await replica?.end();
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
    // PGlite is a single in-process connection: a plain transaction is already a consistent snapshot.
    readOnly: (fn) =>
      client === pglite ? pglite.transaction(async (tx) => fn(wrap(tx))) : fn(wrap(client)),
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
      // Several instances may start together: serialize migrations and re-check under the lock.
      await tx.query('SELECT pg_advisory_xact_lock(727501)');
      if ((await tx.query('SELECT name FROM schema_migrations WHERE name=$1', [file])).length)
        return;
      await tx.exec(sql);
      await tx.query('INSERT INTO schema_migrations(name) VALUES($1)', [file]);
    });
  }
}
