import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DbClient } from "./db.js";

const MIGRATIONS: Array<{ version: number; file: string }> = [
  { version: 1, file: "schema.sql" },
  { version: 2, file: "schema-v2.sql" },
  { version: 3, file: "schema-v3.sql" },
  { version: 4, file: "schema-v4.sql" },
  { version: 5, file: "schema-v5.sql" },
];

function loadSql(file: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const fromDist = join(here, file);
  const fromSrc = join(here, "..", "src", file);
  try {
    return readFileSync(fromDist, "utf8");
  } catch {
    return readFileSync(fromSrc, "utf8");
  }
}

/** Idempotent: safe to run on every boot/deploy. Later phases append versions. */
export async function migrate(db: DbClient): Promise<{ applied: number[] }> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`,
  );
  const done = await db.query<{ version: number }>("SELECT version FROM schema_migrations");
  const appliedVersions = new Set(done.rows.map((row) => Number(row.version)));
  const applied: number[] = [];

  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) {
      continue;
    }
    await db.query(loadSql(migration.file));
    await db.query("INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING", [
      migration.version,
    ]);
    applied.push(migration.version);
  }
  return { applied };
}
