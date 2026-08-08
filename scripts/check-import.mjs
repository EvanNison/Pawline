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
import { databaseUrl } from "./db-url.mjs";

const SCHEMA = "pawline_importcheck";
const base = databaseUrl();

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

  // Capabilities must be a real jsonb ARRAY, not a jsonb string containing array
  // text. `${JSON.stringify(x)}::jsonb` produces the latter, which every array
  // operator then mangles -- appending to one loses the existing capabilities
  // entirely. A defensive reader hid this for a long time.
  const { addCapability } = await import("../src/lib/store.ts");
  const [kind] = await admin.unsafe(
    `select jsonb_typeof(capabilities) as t from ${SCHEMA}.pets where id = 'csv:Rex'`
  );
  check("capabilities is stored as a jsonb array", kind.t === "array", `jsonb_typeof = ${kind.t}`);

  await addCapability("csv:Rex", "weight");
  await addCapability("csv:Rex", "weight"); // idempotent
  const afterCap = (await listPets()).find((p) => p.id === "csv:Rex");
  check("adding a capability keeps the existing ones", afterCap.capabilities.includes("resting_heart_rate"),
    JSON.stringify(afterCap.capabilities));
  check("adding a capability adds the new one exactly once",
    afterCap.capabilities.filter((c) => c === "weight").length === 1,
    JSON.stringify(afterCap.capabilities));
  check("a hand-logged metric becomes visible to the dashboard",
    availableMetrics(afterCap.species, afterCap.capabilities).some((m) => m.key === "weight"),
    "weight still filtered out");

  // An unknown metric must be refused by the bulk path too, not just the single.
  const refused = await writeReadingsBulk("csv:Rex", "csv", [
    { petKey: "Rex", date: "2026-09-09", metric: "not_a_real_metric", value: 1 },
  ]);
  check("bulk path refuses unknown metrics", refused === 0, `wrote ${refused}`);

  // A CSV-only install must actually produce alerts. It previously could not:
  // the collect route returned before alert detection when no vendor source was
  // scheduled, so an import-only user got charts and never a single alert --
  // while the setup guide said the app worked fully without a vendor account.
  const { raiseAndWithdrawAlerts } = await import("../src/lib/alert-run.ts");

  // 70 normal days, then a sustained drop well outside the usual range.
  const long = [];
  for (let i = 0; i < 70; i++) {
    const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    long.push({ petKey: "Alert", date: d, metric: "resting_heart_rate", value: 60 + (i % 3) });
  }
  for (let i = 70; i < 74; i++) {
    const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    long.push({ petKey: "Alert", date: d, metric: "resting_heart_rate", value: 95 });
  }
  const today = long[long.length - 1].date;
  await upsertPet("csv", { key: "Alert", name: "Alert", species: "dog", timezone: "UTC",
    capabilities: ["resting_heart_rate"] }, "UTC");
  await writeReadingsBulk("csv:Alert", "csv", long);
  await raiseAndWithdrawAlerts("csv:Alert", today, []);

  const raised = await admin.unsafe(
    `select metric, severity, direction from ${SCHEMA}.alerts where pet_id = 'csv:Alert'`
  );
  check(
    "imported data alone produces an alert",
    raised.length > 0,
    `no alert raised from ${long.length} imported readings ending in a sustained deviation`
  );
  if (raised.length > 0) {
    check("the alert names the deviating metric", raised[0].metric === "resting_heart_rate", raised[0].metric);
    check("and its direction", raised[0].direction === "high", raised[0].direction);
  }

  // A second, narrower import must not hide what the first one stored. Pet
  // upserts used to REPLACE capabilities, and every page filters charts by
  // them, so importing a file with fewer columns made earlier readings
  // unreachable while they still sat in the table.
  const wide = "date,pet,resting_heart_rate,night_sleep_minutes,scratching\n2026-07-01,Wide,61,470,30";
  const narrow = "date,pet,resting_heart_rate\n2026-07-02,Wide,62";
  for (const text of [wide, narrow]) {
    const src = new CsvSource(text, { timezone: "America/New_York", species: "dog" });
    const parsedRun = parseCsv(text);
    for (const pet of await src.listPets()) {
      const pid = await upsertPet("csv", pet, "America/New_York");
      await writeReadingsBulk(pid, "csv", parsedRun.readings.filter((r) => r.petKey === pet.key));
    }
  }
  const widePet = (await listPets()).find((p) => p.id === "csv:Wide");
  check("a narrower re-import keeps the earlier capabilities",
    ["resting_heart_rate", "night_sleep_minutes", "scratching"].every((k) => widePet.capabilities.includes(k)),
    JSON.stringify(widePet.capabilities));

  // Changing the timezone setting must actually reach a pet that already
  // exists; the conflict clause used to omit it, so "today" kept using the old
  // zone while Setup said the change had taken effect.
  const srcTz = new CsvSource(narrow, { timezone: "Australia/Sydney", species: "dog" });
  for (const pet of await srcTz.listPets()) await upsertPet("csv", pet, "Australia/Sydney");
  const movedPet = (await listPets()).find((p) => p.id === "csv:Wide");
  check("a timezone change reaches an existing pet", movedPet.timezone === "Australia/Sydney", movedPet.timezone);

  // Muting after an alert already exists must actually silence it, and
  // unmuting must lift it. `muted` was copied only at insert, so the setting
  // appeared to do nothing on an open episode -- or kept suppressing after
  // being switched off.
  await raiseAndWithdrawAlerts("csv:Alert", today, ["resting_heart_rate"]);
  const [afterMute] = await admin.unsafe(
    `select muted from ${SCHEMA}.alerts where pet_id = 'csv:Alert' and metric = 'resting_heart_rate'`
  );
  check("muting silences an alert that already exists", afterMute.muted === true, `muted = ${afterMute.muted}`);

  await raiseAndWithdrawAlerts("csv:Alert", today, []);
  const [afterUnmute] = await admin.unsafe(
    `select muted from ${SCHEMA}.alerts where pet_id = 'csv:Alert' and metric = 'resting_heart_rate'`
  );
  check("unmuting lifts it again", afterUnmute.muted === false, `muted = ${afterUnmute.muted}`);

  // The gate that protects someone's subscription, proved against a real
  // database rather than a mock. Setting the enabled flag alone must not be
  // enough: without a recorded acknowledgement the source must stay dark.
  const { isEnabled, setEnabled, scheduledSources, recordAcknowledgement } =
    await import("../src/lib/sources/registry.ts");

  await setEnabled("tractive", true);
  check("enabling without acknowledgement does not enable the source", (await isEnabled("tractive")) === false);
  check("and it is not scheduled to run", (await scheduledSources()).length === 0);

  await recordAcknowledgement("tractive");
  check("acknowledging is what actually opens the gate", (await isEnabled("tractive")) === true);

  await setEnabled("tractive", false);
  check("turning it off closes it again even with the acknowledgement on file",
    (await isEnabled("tractive")) === false);

  await sql().end({ timeout: 5 });
} finally {
  await admin.unsafe(`drop schema if exists ${SCHEMA} cascade`).catch(() => {});
  await admin.end({ timeout: 5 });
}

console.log(failed === 0 ? "\nImport path works against a real database." : `\n${failed} FAILURES`);
process.exit(failed ? 1 : 0);
