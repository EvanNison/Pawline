import { test } from "node:test";
import assert from "node:assert/strict";
import { LATEST_VERSION, MIGRATIONS, migrate, pendingMigrations, validateMigrations, type SqlRunner } from "../schema";

test("migration list is structurally sound", () => {
  assert.deepEqual(validateMigrations(), []);
});

test("versions are unique, ascending and start at 1", () => {
  assert.equal(MIGRATIONS[0].version, 1);
  const versions = MIGRATIONS.map((m) => m.version);
  assert.deepEqual(versions, [...versions].sort((a, b) => a - b));
  assert.equal(new Set(versions).size, versions.length);
  assert.equal(LATEST_VERSION, versions[versions.length - 1]);
});

test("validateMigrations catches the mistakes it exists to catch", () => {
  assert.match(validateMigrations([
    { version: 1, name: "a", statements: ["x"] },
    { version: 1, name: "b", statements: ["y"] },
  ]).join(" "), /duplicate version 1/);

  assert.match(validateMigrations([
    { version: 2, name: "a", statements: ["x"] },
    { version: 1, name: "b", statements: ["y"] },
  ]).join(" "), /not after/);

  assert.match(validateMigrations([{ version: 1, name: "a", statements: [] }]).join(" "), /no statements/);
  assert.match(validateMigrations([{ version: 1, name: " ", statements: ["x"] }]).join(" "), /no name/);
});

test("pendingMigrations respects the current version", () => {
  assert.equal(pendingMigrations(0).length, MIGRATIONS.length);
  assert.equal(pendingMigrations(LATEST_VERSION).length, 0);
  assert.equal(pendingMigrations(LATEST_VERSION + 5).length, 0, "a newer database is left alone");
});

/** In-memory runner recording the exact call order. */
function fakeRunner(opts: { startAt?: number; failOn?: string } = {}) {
  const log: string[] = [];
  let version = opts.startAt ?? 0;
  const runner: SqlRunner = {
    async exec(s) {
      const head = s.trim().split(/\s+/).slice(0, 3).join(" ");
      if (opts.failOn && s.includes(opts.failOn)) {
        log.push(`FAIL ${head}`);
        throw new Error("boom");
      }
      log.push(`exec ${head}`);
    },
    async currentVersion() {
      return version;
    },
    async setVersion(v) {
      log.push(`setVersion ${v}`);
      version = v;
    },
    async begin() {
      log.push("begin");
    },
    async commit() {
      log.push("commit");
    },
    async rollback() {
      log.push("rollback");
    },
  };
  return { runner, log, version: () => version };
}

test("migrate applies everything from a fresh database", async () => {
  const { runner, log, version } = fakeRunner();
  const result = await migrate(runner);
  assert.equal(result.from, 0);
  assert.equal(result.to, LATEST_VERSION);
  assert.deepEqual(result.applied, MIGRATIONS.map((m) => m.version));
  assert.equal(version(), LATEST_VERSION);
  assert.equal(log[0], "begin");
  assert.equal(log[log.length - 1], "commit");
});

test("migrate is a no-op on an up-to-date database", async () => {
  const { runner, log } = fakeRunner({ startAt: LATEST_VERSION });
  const result = await migrate(runner);
  assert.deepEqual(result.applied, []);
  assert.deepEqual(log, [], "no transaction is opened when there is nothing to do");
});

test("the version bump is inside the transaction", async () => {
  const { log } = fakeRunner();
  await migrate(fakeRunner().runner);
  const { runner, log: l } = fakeRunner();
  await migrate(runner);
  const begin = l.indexOf("begin");
  const setVersion = l.findIndex((e) => e.startsWith("setVersion"));
  const commit = l.indexOf("commit");
  assert.ok(begin < setVersion && setVersion < commit, `order was ${l.join(" -> ")}`);
  assert.equal(log.length, 0);
});

test("a failing migration rolls back and leaves the version untouched", async () => {
  const { runner, log, version } = fakeRunner({ failOn: "create table alerts" });
  await assert.rejects(() => migrate(runner), /migration 1 \(initial\) failed/);
  assert.ok(log.includes("rollback"));
  assert.ok(!log.includes("commit"));
  assert.equal(version(), 0, "a half-applied migration must not advance the version");
});

test("every migration is re-runnable from scratch without duplicate object names", () => {
  // Two migrations must not both create the same table; the second would fail
  // on a fresh database, which is the one case nobody tests manually.
  const created = new Set<string>();
  for (const m of MIGRATIONS) {
    for (const s of m.statements) {
      const match = /create (?:table|index)\s+(\w+)/i.exec(s);
      if (match) {
        assert.ok(!created.has(match[1]), `${match[1]} created twice (migration ${m.version})`);
        created.add(match[1]);
      }
    }
  }
});

test("schema records what a status page needs", () => {
  const sql = MIGRATIONS.flatMap((m) => m.statements).join("\n");
  // A run log is the only way to tell "cron never fired" from "it fired and
  // failed"; import_jobs is what makes a long backfill resumable.
  assert.match(sql, /create table runs/);
  assert.match(sql, /create table import_jobs/);
  // Naming the table is not enough: without these columns the reason an import
  // stopped is lost on the next read, and a capped job looks complete.
  assert.match(sql, /finished_reason/, "import_jobs must persist why it stopped");
  assert.match(sql, /days_with_data/, "and how many days actually held data");
  // Credentials are NOT guaranteed by the schema. They live in app_config,
  // encrypted by protect() on the write path, and that guarantee is tested in
  // crypto.test.ts and secrets.test.ts where it actually lives. A dedicated
  // table asserted here for a long time and was never written to once — the
  // assertion was checking a promise nothing kept.
  assert.match(sql, /create table app_config/);
  assert.doesNotMatch(sql, /weight_lb|distance_mi/, "no unit baked into a column name");
});

test("pending migrations are ordered even when the source list is not", () => {
  // Applying 2 before 1 fails on a fresh database — the one case nobody tests
  // by hand, because every existing database already has 1.
  const scrambled: typeof MIGRATIONS = [
    { version: 3, name: "c", statements: ["c"] },
    { version: 1, name: "a", statements: ["a"] },
    { version: 2, name: "b", statements: ["b"] },
  ];
  assert.deepEqual(pendingMigrations(0, scrambled).map((m) => m.version), [1, 2, 3]);
  assert.deepEqual(pendingMigrations(1, scrambled).map((m) => m.version), [2, 3]);
  assert.deepEqual(pendingMigrations(3, scrambled), []);
});

test("the alerts table can hold the documented lifecycle", () => {
  // docs/DECISIONS.md section 9 requires these as distinct facts. The
  // predecessor collapsed "delivered" and "resolved" into one flag, and every
  // fix for one then broke the other.
  const sql = MIGRATIONS.flatMap((m) => m.statements).join("\n");
  const alerts = sql.slice(sql.indexOf("create table alerts"), sql.indexOf("create table journal"));
  for (const col of ["acknowledged", "emailed", "resolved", "days_outside", "note"]) {
    assert.match(alerts, new RegExp(`\\b${col}\\b`), `alerts is missing ${col}`);
  }
});
