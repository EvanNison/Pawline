/**
 * Database access and migration execution.
 *
 * `schema.ts` defines WHAT the migrations are and is fully unit-tested against
 * a fake runner. This file is the thin part that talks to a real Postgres, kept
 * separate so the interesting logic never needs a database to test.
 */

import postgres from "postgres";
import { LATEST_VERSION, migrate as runMigrations, type SqlRunner } from "./schema";

declare global {
  // eslint-disable-next-line no-var
  var __pawlineSql: ReturnType<typeof postgres> | undefined;
}

export function sql() {
  if (!global.__pawlineSql) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    global.__pawlineSql = postgres(url, { ssl: "require", max: 3 });
  }
  return global.__pawlineSql;
}

let migrated = false;

/**
 * Bring the database up to date. Cheap after the first call in a process.
 *
 * The version lives in its own table rather than being inferred from what
 * happens to exist: "the table is there" is not evidence that the migration
 * which created it finished, or that later ones ran at all.
 */
export async function ensureSchema(): Promise<void> {
  if (migrated) return;
  const s = sql();
  await s`create table if not exists schema_version (
    id int primary key default 1,
    version int not null default 0,
    updated_at timestamptz not null default now()
  )`;
  await s`insert into schema_version (id, version) values (1, 0) on conflict (id) do nothing`;

  // A Postgres advisory lock, so two instances starting at once cannot both
  // decide the same migration is pending and apply it twice. A future data
  // migration applied twice would corrupt values rather than merely fail.
  const LOCK = 0x7061776c; // "pawl"
  await s`select pg_advisory_lock(${LOCK})`;
  try {
    const runner: SqlRunner = {
      async exec(statement) {
        await s.unsafe(statement);
      },
      async currentVersion() {
        const [row] = await s`select version from schema_version where id = 1`;
        return Number(row?.version ?? 0);
      },
      async setVersion(version) {
        await s`update schema_version set version = ${version}, updated_at = now() where id = 1`;
      },
      async begin() {
        await s.unsafe("begin");
      },
      async commit() {
        await s.unsafe("commit");
      },
      async rollback() {
        await s.unsafe("rollback");
      },
    };
    await runMigrations(runner);
  } finally {
    await s`select pg_advisory_unlock(${LOCK})`;
  }
  migrated = true;
}

/** Current and expected schema version, for the status page. */
export async function schemaState(): Promise<{ current: number; expected: number }> {
  const s = sql();
  const [row] = await s`select version from schema_version where id = 1`;
  return { current: Number(row?.version ?? 0), expected: LATEST_VERSION };
}
