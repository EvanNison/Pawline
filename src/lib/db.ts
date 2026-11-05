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
  var __pawlineSql: ReturnType<typeof postgres> | undefined;
}

export function sql() {
  if (!global.__pawlineSql) {
    const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    // TLS is required for any real host. A database on this same machine (local
    // development) is the one case where there is no network to protect.
    const host = (() => {
      try {
        return new URL(url).hostname;
      } catch {
        return "";
      }
    })();
    const local = host === "localhost" || host === "127.0.0.1" || host === "::1";
    global.__pawlineSql = postgres(url, { ssl: local ? false : "require", max: 3 });
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

  // Everything below must run on ONE connection, so the pool is bypassed with a
  // reserved one. This is load-bearing, not tidiness: `pg_advisory_lock` is
  // scoped to a session, and `begin`/`commit` are session state. Issued through
  // a pool of 3 they can each land on a different connection — so the lock
  // guards a session that is not the one migrating, `commit` may reach a
  // connection that never began, and `pg_advisory_unlock` can be sent to a
  // session that holds nothing while the real holder keeps the lock until it is
  // recycled. The atomic migrations and the mutual exclusion were both
  // nominally present and neither actually held.
  const reserved = await sql().reserve();
  const LOCK = 0x7061776c; // "pawl"
  try {
    // Taken before the bootstrap DDL so that two instances starting together
    // serialise here rather than racing `create table if not exists`, which can
    // still collide in the catalog.
    await reserved`select pg_advisory_lock(${LOCK})`;
    try {
      await reserved`create table if not exists schema_version (
        id int primary key default 1,
        version int not null default 0,
        updated_at timestamptz not null default now()
      )`;
      await reserved`insert into schema_version (id, version) values (1, 0) on conflict (id) do nothing`;

      const runner: SqlRunner = {
        async exec(statement) {
          await reserved.unsafe(statement);
        },
        async currentVersion() {
          const [row] = await reserved`select version from schema_version where id = 1`;
          return Number(row?.version ?? 0);
        },
        async setVersion(version) {
          await reserved`update schema_version set version = ${version}, updated_at = now() where id = 1`;
        },
        async begin() {
          await reserved.unsafe("begin");
        },
        async commit() {
          await reserved.unsafe("commit");
        },
        async rollback() {
          await reserved.unsafe("rollback");
        },
      };
      await runMigrations(runner);
    } finally {
      await reserved`select pg_advisory_unlock(${LOCK})`;
    }
  } finally {
    // Must happen even if unlocking threw, or the connection leaks out of the
    // pool and the next deploy starts one connection poorer, permanently.
    reserved.release();
  }
  migrated = true;
}

/** Current and expected schema version, for the status page. */
export async function schemaState(): Promise<{ current: number; expected: number }> {
  const s = sql();
  const [row] = await s`select version from schema_version where id = 1`;
  return { current: Number(row?.version ?? 0), expected: LATEST_VERSION };
}
