import postgres from 'postgres';

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

export function createClient(url: string, options: postgres.Options<{}> = {}): Sql {
  return postgres(url, {
    max: 10,
    onnotice: () => {},
    ...options,
  });
}

const globalKey = Symbol.for('hazard.db.sql');
type GlobalWithSql = typeof globalThis & { [globalKey]?: Sql };

/** Shared connection pool, created on first use (survives Next.js dev reloads). */
export function getSql(): Sql {
  const g = globalThis as GlobalWithSql;
  if (!g[globalKey]) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL is not set');
    g[globalKey] = createClient(url);
  }
  return g[globalKey];
}
