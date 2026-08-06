/**
 * Versioned schema migrations.
 *
 * The private predecessor used `create table if not exists` on every request.
 * That is fine exactly once and then never again: it cannot rename a column,
 * change a unit, add a constraint, or backfill existing rows — so the schema
 * freezes at v1 and every later change becomes a manual database chore the
 * non-technical owner of a self-hosted install cannot perform.
 *
 * Rules:
 *   - Migrations are append-only. Never edit a shipped migration; add another.
 *   - Each runs inside a transaction, and the version bump is in that same
 *     transaction, so a failure leaves the database on the previous version
 *     rather than half-migrated.
 *   - Data conversions belong here too (see the unit conversion in 002).
 */

export interface Migration {
  version: number;
  name: string;
  /** Statements executed in order, inside one transaction. */
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial",
    statements: [
      `create table pets (
        id            text primary key,
        source_id     text not null,
        source_key    text not null,
        name          text not null,
        species       text not null default 'unknown',
        timezone      text not null,
        capabilities  jsonb not null default '[]'::jsonb,
        created_at    timestamptz not null default now(),
        updated_at    timestamptz not null default now(),
        unique (source_id, source_key)
      )`,
      // Values are stored in the canonical unit declared by metrics.ts. The
      // unit is never per-row and never per-user; see units.ts.
      `create table daily_metrics (
        pet_id      text not null references pets(id) on delete cascade,
        date        date not null,
        metric      text not null,
        value       double precision not null,
        source_id   text not null,
        updated_at  timestamptz not null default now(),
        primary key (pet_id, date, metric)
      )`,
      `create index daily_metrics_lookup on daily_metrics (pet_id, metric, date desc)`,
      `create table alerts (
        id                bigserial primary key,
        pet_id            text not null references pets(id) on delete cascade,
        date              date not null,
        metric            text not null,
        direction         text not null,
        value             double precision,
        baseline_median   double precision,
        baseline_spread   double precision,
        severity          text not null,
        acknowledged      boolean not null default false,
        created_at        timestamptz not null default now(),
        unique (pet_id, date, metric)
      )`,
      `create table journal (
        id          bigserial primary key,
        pet_id      text not null references pets(id) on delete cascade,
        date        date not null,
        category    text not null default 'note',
        note        text not null,
        created_at  timestamptz not null default now()
      )`,
      // Raw vendor payloads, kept forever. Parsing can always be re-run; a
      // payload that was never captured is gone for good.
      `create table snapshots (
        id          bigserial primary key,
        pet_id      text references pets(id) on delete cascade,
        source_id   text not null,
        kind        text not null,
        fetched_at  timestamptz not null default now(),
        raw         jsonb not null
      )`,
      `create table app_config (
        key         text primary key,
        value       text not null,
        updated_at  timestamptz not null default now()
      )`,
      // Credentials are stored encrypted (AES-GCM). The column holds the
      // ciphertext envelope, never a readable password.
      `create table source_credentials (
        source_id   text primary key,
        ciphertext  text not null,
        updated_at  timestamptz not null default now()
      )`,
      // Every collection or import attempt is recorded, successful or not.
      // Without this a /status page cannot distinguish "the cron never fired"
      // from "it fired and failed before storing anything" — which are very
      // different problems with very different fixes.
      `create table runs (
        id           bigserial primary key,
        pet_id       text references pets(id) on delete cascade,
        source_id    text not null,
        kind         text not null,
        started_at   timestamptz not null default now(),
        finished_at  timestamptz,
        ok           boolean,
        days_written int not null default 0,
        error        text
      )`,
      `create index runs_recent on runs (source_id, started_at desc)`,
      // Resumable history import. A full backfill is thousands of requests and
      // cannot complete in one serverless invocation, so progress lives here.
      `create table import_jobs (
        id            bigserial primary key,
        pet_id        text not null references pets(id) on delete cascade,
        source_id     text not null,
        state         text not null default 'pending',
        cursor_date   date,
        earliest_date date,
        latest_date   date,
        days_done     int not null default 0,
        days_empty    int not null default 0,
        last_error    text,
        created_at    timestamptz not null default now(),
        updated_at    timestamptz not null default now(),
        unique (pet_id, source_id)
      )`,
    ],
  },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/**
 * Migrations that still need to run, given the database's current version.
 *
 * Sorted defensively: applying 002 before 001 would fail against a fresh
 * database in a way nobody tests by hand, and source order is not a guarantee.
 * Takes the list as a parameter so that guarantee can actually be tested.
 */
export function pendingMigrations(
  currentVersion: number,
  migrations: Migration[] = MIGRATIONS
): Migration[] {
  return migrations.filter((m) => m.version > currentVersion).sort((a, b) => a.version - b.version);
}

/** Structural invariants — asserted by tests, not at runtime. */
export function validateMigrations(migrations: Migration[] = MIGRATIONS): string[] {
  const problems: string[] = [];
  const seen = new Set<number>();
  let previous = 0;
  for (const m of migrations) {
    if (seen.has(m.version)) problems.push(`duplicate version ${m.version}`);
    seen.add(m.version);
    if (m.version <= previous) problems.push(`version ${m.version} is not after ${previous}`);
    if (m.version !== Math.floor(m.version) || m.version < 1) problems.push(`version ${m.version} is not a positive integer`);
    if (!m.name.trim()) problems.push(`version ${m.version} has no name`);
    if (m.statements.length === 0) problems.push(`version ${m.version} has no statements`);
    previous = m.version;
  }
  return problems;
}

/** Minimal surface the runner needs, so it can be tested without a database. */
export interface SqlRunner {
  exec(statement: string): Promise<void>;
  currentVersion(): Promise<number>;
  setVersion(version: number): Promise<void>;
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface MigrateResult {
  from: number;
  to: number;
  applied: number[];
}

/**
 * Apply pending migrations. Each is atomic with its own version bump, so an
 * interrupted run resumes cleanly rather than leaving a half-built schema.
 */
export async function migrate(runner: SqlRunner): Promise<MigrateResult> {
  const from = await runner.currentVersion();
  const applied: number[] = [];
  for (const m of pendingMigrations(from)) {
    await runner.begin();
    try {
      for (const statement of m.statements) await runner.exec(statement);
      await runner.setVersion(m.version);
      await runner.commit();
      applied.push(m.version);
    } catch (e) {
      await runner.rollback();
      throw new Error(`migration ${m.version} (${m.name}) failed: ${String(e)}`);
    }
  }
  return { from, to: await runner.currentVersion(), applied };
}
