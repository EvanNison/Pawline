/**
 * Validate every SQL query in the source against a real Postgres schema.
 *
 * Unit tests run against a fake SQL runner, so a query can be syntactically
 * fine, fully "tested", and still reference a column that does not exist. Two
 * such bugs have already shipped:
 *
 *   - `date >= ${today}::date - ${WINDOW}` — the untyped parameter made
 *     Postgres resolve `date - date` to integer, then fail on `date >= integer`.
 *     It broke collection in the predecessor app for two days.
 *   - `select ... trigger from runs` — the column is named `kind`. The status
 *     page, the one you open when something looks wrong, was the only reader
 *     that disagreed with the schema.
 *
 * Neither is detectable without a database. So: build the real schema in a
 * throwaway namespace, extract every tagged template in src/, and PREPARE it.
 * PREPARE resolves identifiers, types and operators without running anything —
 * which is exactly the layer both bugs lived in.
 */
import postgres from "postgres";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { databaseUrl } from "./db-url.mjs";

const SCHEMA = "pawline_sqlcheck";

function sourceFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) {
      if (e !== "__tests__" && e !== "node_modules") out.push(...sourceFiles(p));
    } else if (/\.(ts|tsx)$/.test(e)) out.push(p);
  }
  return out;
}

/**
 * Pull out `sql`...`` / `s`...`` tagged templates.
 *
 * Hand-rolled rather than regex: a query containing `${...}` with nested braces
 * or a brace inside a string defeats regex matching, and a silently-missed
 * query is worse than none — it reads as "checked" when it never was.
 */
function extractQueries(src, file) {
  const found = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== "`") continue;
    // Every tag shape a client can take here: `s\`…\`` and `reserved\`…\`` where
    // the variable is a client, and `sql()\`…\`` where a call returns one.
    // Missing a shape is silent, and twice has left whole files unchecked while
    // the README claimed full coverage — a checker that quietly skips things is
    // worse than no checker, because it is believed.
    const tag = /(^|[^A-Za-z0-9_$.])(sql|s|reserved)(\(\))?$/.exec(src.slice(0, i));
    if (!tag) continue;

    let j = i + 1;
    let depth = 0;
    let params = 0;
    let text = "";
    for (; j < src.length; j++) {
      const c = src[j];
      if (depth === 0 && c === "`") break;
      if (c === "$" && src[j + 1] === "{") {
        depth = 1;
        j++;
        let brace = 1;
        // Skip the interpolation, tracking nesting so `${a ? {x:1} : y}` works.
        while (++j < src.length && brace > 0) {
          if (src[j] === "{") brace++;
          else if (src[j] === "}") brace--;
        }
        j--;
        depth = 0;
        text += `$${++params}`;
        continue;
      }
      text += c;
    }
    const line = src.slice(0, i).split("\n").length;
    if (/\b(select|insert|update|delete|create|alter)\b/i.test(text)) {
      found.push({ file, line, text: text.trim(), params });
    }
    i = j;
  }
  return found;
}

const url = databaseUrl();
const sql = postgres(url, { ssl: "require", max: 1, connect_timeout: 45, onnotice: () => {} });

let checked = 0;
const failures = [];
try {
  await sql.unsafe(`drop schema if exists ${SCHEMA} cascade`);
  await sql.unsafe(`create schema ${SCHEMA}`);
  await sql.unsafe(`set search_path to ${SCHEMA}`);

  // ensureSchema() creates this one directly, outside MIGRATIONS — it has to
  // exist before the migration runner can ask what version it is at.
  await sql.unsafe(`create table schema_version (
    id int primary key default 1,
    version int not null default 0,
    updated_at timestamptz not null default now())`);

  const { MIGRATIONS } = await import("../src/lib/schema.ts");
  for (const m of MIGRATIONS) for (const stmt of m.statements) await sql.unsafe(stmt);

  const root = fileURLToPath(new URL("../src/", import.meta.url));
  for (const file of sourceFiles(root)) {
    const rel = file.slice(root.length);
    for (const q of extractQueries(readFileSync(file, "utf8"), rel)) {
      // Dynamic identifiers (`${sql("schema")}`) become $N, which cannot be a
      // table name. Not checkable this way; reported so it is never silent.
      // PREPARE accepts only SELECT/INSERT/UPDATE/DELETE/VALUES. DDL is
      // executed for real above, so it is checked more strictly, not less.
      if (/^\s*(create|alter|drop)\b/i.test(q.text)) continue;
      // postgres.js helpers — sql(rows, ...cols) for bulk values, sql('ident')
      // for dynamic identifiers — collapse to a bare $N that PREPARE cannot
      // type. Reported rather than dropped, so "checked" never quietly means
      // "checked except the ones that were hard". These need execution tests.
      if (
        /\bfrom\s+\$\d|\bjoin\s+\$\d|\binto\s+\$\d|\bupdate\s+\$\d/i.test(q.text) ||
        /\binsert\s+into\s+[a-z_."]+\s+\$\d/i.test(q.text)
      ) {
        failures.push({ ...q, error: "SKIPPED: postgres.js helper — needs an execution test" });
        continue;
      }
      checked++;
      const name = `c${checked}`;
      try {
        await sql.unsafe(`prepare ${name} as ${q.text}`);
        await sql.unsafe(`deallocate ${name}`);
      } catch (e) {
        failures.push({ ...q, error: String(e.message).split("\n")[0] });
      }
    }
  }
} finally {
  await sql.unsafe(`drop schema if exists ${SCHEMA} cascade`).catch(() => {});
  await sql.end({ timeout: 5 });
}

console.log(`prepared ${checked} queries from src/ against the real schema`);
for (const f of failures) console.log(`\n  ${f.file}:${f.line}\n    ${f.error}\n    ${f.text.replace(/\s+/g, " ").slice(0, 150)}`);
const real = failures.filter((f) => !f.error.startsWith("SKIPPED"));
console.log(real.length === 0 ? "\nAll queries valid against the schema." : `\n${real.length} INVALID QUERIES`);
process.exit(real.length ? 1 : 0);
