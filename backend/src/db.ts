import { Pool, type QueryResultRow } from "pg";

/** Minimal query surface so tests can inject fakes; Pool satisfies it. */
export interface DbClient {
  query<T extends QueryResultRow>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export function createPool(databaseUrl: string): Pool {
  const pool = new Pool({ connectionString: databaseUrl });
  // An idle client losing its connection (Postgres restart, network blip)
  // emits "error" on the pool; unhandled, that crashes the process. The
  // pool discards the broken client and reconnects on the next query.
  pool.on("error", (error) => {
    console.error(`postgres idle client error: ${error.message}`);
  });
  return pool;
}
