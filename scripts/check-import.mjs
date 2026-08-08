/**
 * Run the CSV import path against a real Postgres.
 *
 * The bulk writer uses a postgres.js values helper, which PREPARE cannot type —
 * so check-sql.mjs reports it as skipped rather than pretending to have checked
 * it. This is the test that actually covers it: real schema, real rows, real
 * conflict handling.
 *
 * Everything runs in a throwaway namespace and is dropped afterwards.
 */
import postgres from "postgres";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";

const SCHEMA = "pawline_importcheck";
const base = readFileSync(fileURLToPath(new URL(".env.local", import.meta.url)), "utf8")
  .match(/^DATABASE_URL=(.+)$/m)[1]
  .trim()
  .replace(/^["']|["']$/g, "");

const admin = postgres(base, { ssl: "require", max: 1, onnotice: () => {} });
let failed = 0;
const check = (name, cond, detail = "") => {
  if (cond) console.log(`  PASS  ${name}`);
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`); }
};

try {
  await admin.unsafe(`drop schema if exists ${SCHEMA} cascade`);
  await admin.unsafe(`create schema ${SCHEMA}`);

  const direct = base.replace("-pooler", "");
  const sep = direct.includes("?") ? "&" : "?";
  process.env.DATABASE_URL = `${direct}${sep}options=${encodeURIComponent(`-c search_path=${SCHEMA}`)}`;

  const { ensureSchema, sql } = await import("../src/lib/db.ts");
  const { upsertPet, writeReadingsBulk } = await import("../src/lib/store.ts");
  const { parseCsv, CsvSource, summarizeImport } = await import("../src/lib/sources/csv.ts");
  await ensureSchema();

  // Two pets, mixed units, a blank, and a deliberately broken row.
  const csv = [
    "date,pet,resting_heart_rate,night_sleep_minutes,weight_lb",
    "2026-08-01,Rex,62,481,32.0",
    "2026-08-02,Rex,63,,32.1",
    "2026-08-01,Bo,70,500,18.5",
    "2026-08-03,Rex,not-a-number,470,32.0",
  ].join("\n");

  const parsed = parseCsv(csv);
  const summary = summarizeImport(parsed);
  check("parses both pets", summary.pets.length === 2, `got ${summary.pets.length}`);
  check("reports the bad cell", summary.warnings.length === 1, `got ${summary.warnings.length}`);

  const source = new CsvSource(csv, { timezone: "America/New_York", species: "dog" });
  let written = 0;
  for (const pet of await source.listPets()) {
    const petId = await upsertPet("csv", pet, "America/New_York");
    written += await writeReadingsBulk(petId, "csv", parsed.readings.filter((r) => r.petKey === pet.key));
  }
  check("bulk insert executed", written === parsed.readings.length, `wrote ${written} of ${parsed.readings.length}`);

  const [{ count: stored }] = await admin.unsafe(`select count(*)::int as count from ${SCHEMA}.daily_metrics`);
  check("rows are in the table", Number(stored) === written, `table has ${stored}`);

  // Pounds must have become grams, not been stored raw.
  const [w] = await admin.unsafe(
    `select value from ${SCHEMA}.daily_metrics where metric = 'weight' and date = '2026-08-01' and pet_id = 'csv:Rex'`
  );
  check("imperial weight converted to canonical grams", Number(w.value) > 14000 && Number(w.value) < 15000, `stored ${w?.value}`);

  // Re-import must overwrite, not duplicate or error — the whole point of the
  // conflict clause, and what makes "upload a corrected file" safe advice.
  for (const pet of await source.listPets()) {
    const petId = await upsertPet("csv", pet, "America/New_York");
    await writeReadingsBulk(petId, "csv", parsed.readings.filter((r) => r.petKey === pet.key));
  }
  const [{ count: after }] = await admin.unsafe(`select count(*)::int as count from ${SCHEMA}.daily_metrics`);
  check("re-import overwrites rather than duplicating", Number(after) === Number(stored), `${stored} then ${after}`);

  // Chunking boundary: more rows than one statement carries.
  const many = [];
  for (let i = 0; i < 1200; i++) {
    const d = new Date(Date.UTC(2024, 0, 1 + i)).toISOString().slice(0, 10);
    many.push({ petKey: "Rex", date: d, metric: "resting_heart_rate", value: 60 + (i % 5) });
  }
  const bulk = await writeReadingsBulk("csv:Rex", "csv", many, 500);
  check("writes across chunk boundaries", bulk === 1200, `wrote ${bulk}`);

  const [{ count: total }] = await admin.unsafe(
    `select count(*)::int as count from ${SCHEMA}.daily_metrics where metric = 'resting_heart_rate' and pet_id = 'csv:Rex'`
  );
  check("all chunked rows landed", Number(total) >= 1200, `found ${total}`);

  // The round trip, not just the write. jsonb comes back from this driver as a
  // string, and a TypeScript cast hid that: capabilities became a set of single
  // characters and every dashboard rendered zero charts. Only a real read can
  // see this, so it is asserted here rather than trusted.
  const { listPets } = await import("../src/lib/store.ts");
  const { availableMetrics } = await import("../src/lib/metrics.ts");
  const storedPets = await listPets();
  const rex = storedPets.find((p) => p.id === "csv:Rex");
  check("listPets returns capabilities as a real array", Array.isArray(rex?.capabilities), `got ${typeof rex?.capabilities}`);
  check(
    "stored capabilities select the metrics they name",
    availableMetrics(rex.species, rex.capabilities).length >= 3,
    `selected ${availableMetrics(rex?.species ?? "unknown", rex?.capabilities ?? []).length} metrics from ${JSON.stringify(rex?.capabilities)}`
  );

  // An unknown metric must be refused by the bulk path too, not just the single.
  const refused = await writeReadingsBulk("csv:Rex", "csv", [
    { petKey: "Rex", date: "2026-09-09", metric: "not_a_real_metric", value: 1 },
  ]);
  check("bulk path refuses unknown metrics", refused === 0, `wrote ${refused}`);

  await sql().end({ timeout: 5 });
} finally {
  await admin.unsafe(`drop schema if exists ${SCHEMA} cascade`).catch(() => {});
  await admin.end({ timeout: 5 });
}

console.log(failed === 0 ? "\nImport path works against a real database." : `\n${failed} FAILURES`);
process.exit(failed ? 1 : 0);
