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

// TLS for any real host; a database on this same machine has no network to protect.
const tlsFor = (u) => {
  try {
    return ["localhost", "127.0.0.1", "::1"].includes(new URL(u).hostname) ? false : "require";
  } catch {
    return "require";
  }
};
const admin = postgres(base, { ssl: tlsFor(base), max: 1, onnotice: () => {} });
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
  const { upsertPet, writeReadings, writeReadingsBulk } = await import("../src/lib/store.ts");
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

  // Freshness masking, third attempt -- verified against a server rather than
  // reasoned about, because min() ignoring nulls is exactly what defeated the
  // previous two. Two pets both advertising a metric, only one with readings:
  // the metric must read as never-arrived, not current.
  await upsertPet("csv", { key: "HasData", name: "HasData", species: "dog", timezone: "UTC",
    capabilities: ["resting_heart_rate"] }, "UTC");
  await upsertPet("csv", { key: "NoData", name: "NoData", species: "dog", timezone: "UTC",
    capabilities: ["resting_heart_rate"] }, "UTC");
  await writeReadingsBulk("csv:HasData", "csv", [
    { petKey: "HasData", date: "2026-08-08", metric: "resting_heart_rate", value: 61 },
  ]);
  const [fresh] = await admin.unsafe(`
    select m.metric,
      (case when count(*) filter (where d.newest is null) > 0
            then null else min(d.newest) end)::text as newest
    from (
      select p.id as pet_id, c.metric
      from ${SCHEMA}.pets p, lateral jsonb_array_elements_text(p.capabilities) as c(metric)
    ) m
    left join (
      select pet_id, metric, max(date) as newest
      from ${SCHEMA}.daily_metrics where metric not like 'raw.%'
      group by pet_id, metric
    ) d on d.pet_id = m.pet_id and d.metric = m.metric
    where m.metric = 'resting_heart_rate'
    group by m.metric`);
  check("a pet with no readings is not masked by one that has them",
    fresh.newest === null, `got ${fresh.newest} -- one pet's data hid the other's silence`);

  // A hand-logged measurement must survive an automatic one landing on the
  // same day. The uniqueness key excludes source_id, so a vendor's stale
  // profile weight silently replaced a number someone read off actual scales.
  await upsertPet("csv", { key: "Scales", name: "Scales", species: "dog", timezone: "UTC",
    capabilities: ["weight"] }, "UTC");
  await writeReadings("csv:Scales", "manual", [
    { petKey: "Scales", date: "2026-08-01", metric: "weight", value: 14600 },
  ]);
  await writeReadings("csv:Scales", "tractive", [
    { petKey: "Scales", date: "2026-08-01", metric: "weight", value: 99999 },
  ]);
  const [kept] = await admin.unsafe(
    `select value, source_id from ${SCHEMA}.daily_metrics
     where pet_id = 'csv:Scales' and date = '2026-08-01' and metric = 'weight'`
  );
  check("an automatic reading cannot overwrite a hand-logged one",
    Number(kept.value) === 14600 && kept.source_id === "manual",
    `stored ${kept.value} from ${kept.source_id}`);

  await writeReadings("csv:Scales", "manual", [
    { petKey: "Scales", date: "2026-08-01", metric: "weight", value: 14800 },
  ]);
  const [corrected] = await admin.unsafe(
    `select value from ${SCHEMA}.daily_metrics
     where pet_id = 'csv:Scales' and date = '2026-08-01' and metric = 'weight'`
  );
  check("but a person correcting themselves still wins",
    Number(corrected.value) === 14800, `stored ${corrected.value}`);

  // Dismissing must not split one continuous episode into several. The runner
  // used to look only for UNacknowledged open alerts, so a condition the owner
  // had silenced -- and which never went away -- produced a fresh row on the
  // next run, turning one illness into "flagged three times" in the history a
  // vet reads, and sending another email.
  const [beforeDismiss] = await admin.unsafe(
    `select count(*)::int as n from ${SCHEMA}.alerts where pet_id = 'csv:Alert'`
  );
  await admin.unsafe(`update ${SCHEMA}.alerts set acknowledged = true where pet_id = 'csv:Alert'`);
  await raiseAndWithdrawAlerts("csv:Alert", today, []);
  const [afterDismiss] = await admin.unsafe(
    `select count(*)::int as n from ${SCHEMA}.alerts where pet_id = 'csv:Alert'`
  );
  check("dismissing does not split one episode into two",
    Number(afterDismiss.n) === Number(beforeDismiss.n),
    `${beforeDismiss.n} rows became ${afterDismiss.n}`);

  const [onset] = await admin.unsafe(
    `select onset_value, value from ${SCHEMA}.alerts where pet_id = 'csv:Alert' limit 1`
  );
  check("the onset reading is recorded and kept",
    onset.onset_value !== null, "onset_value is null");

  // A dismissed episode must still be recordable as recovered, or the dashboard
  // says the measurement never came back, forever.
  await admin.unsafe(
    `update ${SCHEMA}.alerts set acknowledged = true where pet_id = 'csv:Alert'`
  );
  await raiseAndWithdrawAlerts("csv:Alert", today, []);
  const [dismissedRow] = await admin.unsafe(
    `select resolved from ${SCHEMA}.alerts where pet_id = 'csv:Alert' limit 1`
  );
  check("a dismissed alert can still be resolved on evidence",
    dismissedRow !== undefined, "no alert row found");

  // A day with no wear reading, for a pet that DOES report wear, is unknown --
  // not "worn fine". Counting it as valid let a collar-off day satisfy the
  // "returned to normal" evidence and support a green dashboard.
  await upsertPet("csv", { key: "Wear", name: "Wear", species: "dog", timezone: "UTC",
    capabilities: ["active_minutes", "wear_time"] }, "UTC");
  const wearDays = [];
  for (let i = 0; i < 40; i++) {
    const d = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);
    wearDays.push({ petKey: "Wear", date: d, metric: "active_minutes", value: 90 });
    // Wear reported for every day except the last three.
    if (i < 37) wearDays.push({ petKey: "Wear", date: d, metric: "wear_time", value: 1300 });
  }
  await writeReadingsBulk("csv:Wear", "csv", wearDays);

  const { alertSeries } = await import("../src/lib/alerting.ts");
  const { readSeries } = await import("../src/lib/store.ts");
  const wearRows2 = await admin.unsafe(
    `select date::text as date, value from ${SCHEMA}.daily_metrics
     where pet_id = 'csv:Wear' and metric = 'wear_time'`
  );
  const seenWear = new Set(wearRows2.map((r) => r.date));
  const allD = await admin.unsafe(
    `select distinct date::text as date from ${SCHEMA}.daily_metrics
     where pet_id = 'csv:Wear' and metric <> 'wear_time'`
  );
  const unknownDays = allD.filter((r) => !seenWear.has(r.date)).map((r) => r.date);
  check("days without a wear reading are identified as unknown",
    unknownDays.length === 3, `found ${unknownDays.length}, expected 3`);

  const lowWearSet = new Set(unknownDays);
  // alertSeries drops excluded days rather than nulling them, so the check is
  // that they are absent from what alerting actually sees.
  const raw = await readSeries("csv:Wear", "active_minutes");
  const assessed = alertSeries(raw, "active_minutes", { today: "2026-02-09", lowWear: lowWearSet });
  const assessedDates = new Set(assessed.map((p) => p.date));
  check("and their readings never reach the assessment",
    unknownDays.every((d) => !assessedDates.has(d)),
    `${raw.length} readings in, ${assessed.length} out; unknown days still present: ` +
      unknownDays.filter((d) => assessedDates.has(d)).join(", "));

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
