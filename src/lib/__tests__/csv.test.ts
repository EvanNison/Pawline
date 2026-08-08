import { test } from "node:test";
import assert from "node:assert/strict";
import { CsvSource, parseCsv, summarizeImport } from "../sources/csv";

const TZ = "America/New_York";

test("parses a simple wide file", () => {
  const { readings, warnings, pets } = parseCsv(
    ["date,resting_heart_rate,night_sleep_minutes", "2026-08-01,62,481", "2026-08-02,63,455"].join("\n")
  );
  assert.deepEqual(warnings, []);
  assert.deepEqual(pets, ["My pet"]);
  assert.equal(readings.length, 4);
  assert.deepEqual(readings[0], { petKey: "My pet", date: "2026-08-01", metric: "resting_heart_rate", value: 62 });
});

test("unit suffixes are converted to canonical storage", () => {
  const { readings, warnings } = parseCsv(["date,weight_lb,distance_mi", "2026-08-01,32,3.11"].join("\n"));
  assert.deepEqual(warnings, []);
  const weight = readings.find((r) => r.metric === "weight")!;
  const distance = readings.find((r) => r.metric === "distance")!;
  assert.ok(Math.abs(weight.value - 14515) < 1, `32 lb should be ~14515 g, got ${weight.value}`);
  assert.ok(Math.abs(distance.value - 5004) < 5, `3.11 mi should be ~5004 m, got ${distance.value}`);
});

test("metric and imperial columns land on the same canonical value", () => {
  const lb = parseCsv("date,weight_lb\n2026-08-01,32").readings[0].value;
  const kg = parseCsv("date,weight_kg\n2026-08-01,14.515").readings[0].value;
  assert.ok(Math.abs(lb - kg) < 2, `${lb} vs ${kg}`);
});

test("a unit suffix from the wrong dimension is refused, not guessed", () => {
  const { readings, warnings } = parseCsv("date,weight_km\n2026-08-01,32");
  assert.equal(readings.length, 0);
  assert.match(warnings[0].message, /distance unit for weight/);
});

test("unknown columns warn and are skipped without losing the rest of the row", () => {
  const { readings, warnings } = parseCsv("date,resting_heart_rate,mood_vibes\n2026-08-01,62,9");
  assert.equal(readings.length, 1);
  assert.equal(readings[0].metric, "resting_heart_rate");
  assert.match(warnings[0].message, /unknown metric column "mood_vibes"/);
});

test("blank cells mean 'not measured', never zero", () => {
  const { readings } = parseCsv("date,resting_heart_rate,weight_lb\n2026-08-01,62,\n2026-08-02,,30");
  assert.equal(readings.length, 2);
  assert.ok(!readings.some((r) => r.value === 0));
});

test("non-numeric values warn rather than becoming NaN", () => {
  const { readings, warnings } = parseCsv("date,resting_heart_rate\n2026-08-01,about sixty");
  assert.equal(readings.length, 0);
  assert.match(warnings[0].message, /not a plain number/);
});

test("invalid and impossible dates are rejected", () => {
  const { readings, warnings } = parseCsv(
    ["date,resting_heart_rate", "08/01/2026,62", "2026-02-30,63", "2026-08-01,64"].join("\n")
  );
  assert.equal(readings.length, 1, "only the well-formed row survives");
  assert.equal(warnings.length, 2);
  assert.match(warnings[0].message, /not a valid YYYY-MM-DD/);
});

test("quoted fields, embedded commas and escaped quotes", () => {
  const { readings, pets } = parseCsv('date,pet,resting_heart_rate\n2026-08-01,"Rex, the ""Good"" Boy",62');
  assert.deepEqual(pets, ['Rex, the "Good" Boy']);
  assert.equal(readings[0].petKey, 'Rex, the "Good" Boy');
});

test("multiple pets are separated", () => {
  const { pets, readings } = parseCsv(
    ["date,pet,resting_heart_rate", "2026-08-01,Rex,62", "2026-08-01,Bella,88"].join("\n")
  );
  assert.deepEqual(pets.sort(), ["Bella", "Rex"]);
  assert.equal(readings.filter((r) => r.petKey === "Bella")[0].value, 88);
});

test("duplicate pet+date+metric keeps the first and warns", () => {
  const { readings, warnings } = parseCsv(
    ["date,resting_heart_rate", "2026-08-01,62", "2026-08-01,99"].join("\n")
  );
  assert.equal(readings.length, 1);
  assert.equal(readings[0].value, 62);
  assert.match(warnings[0].message, /duplicate/);
});

test("Excel artefacts: BOM, CRLF, trailing blank lines", () => {
  const { readings, warnings } = parseCsv("﻿date,resting_heart_rate\r\n2026-08-01,62\r\n\r\n");
  assert.deepEqual(warnings, []);
  assert.equal(readings.length, 1);
});

test("headers are case- and space-insensitive", () => {
  const { readings, warnings } = parseCsv("Date,Resting Heart Rate\n2026-08-01,62");
  assert.deepEqual(warnings, []);
  assert.equal(readings[0].metric, "resting_heart_rate");
});

test("a file with no date column fails with a usable message", () => {
  const { warnings, readings } = parseCsv("day,resting_heart_rate\n2026-08-01,62");
  assert.equal(readings.length, 0);
  assert.match(warnings[0].message, /no "date" column/);
});

test("an empty file does not throw", () => {
  assert.equal(parseCsv("").readings.length, 0);
  assert.equal(parseCsv("   \n\n").readings.length, 0);
});

test("CsvSource reports capabilities from what the file actually contains", async () => {
  const src = new CsvSource("date,pet,resting_heart_rate,barking_events\n2026-08-01,Rex,62,4", {
    timezone: TZ,
    species: "dog",
  });
  assert.equal(await src.check(), null);
  const [pet] = await src.listPets();
  assert.equal(pet.name, "Rex");
  assert.equal(pet.species, "dog");
  assert.deepEqual(pet.capabilities.sort(), ["barking_events", "resting_heart_rate"]);
});

test("CsvSource.fetchDay is idempotent and empty for unknown days", async () => {
  const src = new CsvSource("date,resting_heart_rate\n2026-08-01,62", { timezone: TZ });
  const a = await src.fetchDay("My pet", "2026-08-01");
  const b = await src.fetchDay("My pet", "2026-08-01");
  assert.deepEqual(a, b);
  assert.deepEqual(await src.fetchDay("My pet", "2026-08-09"), []);
});

test("CsvSource.check explains an unusable file instead of returning null", async () => {
  const src = new CsvSource("nonsense", { timezone: TZ });
  assert.notEqual(await src.check(), null);
});

test("a row with the wrong number of cells is refused, not shifted", () => {
  // The dangerous case: an unquoted thousands separator. Every value after the
  // extra comma lands in the wrong column, and each one looks plausible.
  const { readings, warnings } = parseCsv(
    ["date,weight_kg,resting_heart_rate", "2026-08-01,14,515,62"].join("\n")
  );
  assert.equal(readings.length, 0, "must not import 14 g of dog and a heart rate of 515");
  assert.match(warnings[0].message, /3 values but the header has 3|4 values but the header has 3/);
  assert.match(warnings[0].message, /unquoted comma/);
});

test("a quote in the middle of a value is not silently deleted", () => {
  // `6"2` used to become `62` and be stored as a heart rate.
  const { readings, warnings } = parseCsv('date,resting_heart_rate\n2026-08-01,6"2');
  assert.equal(readings.length, 0);
  assert.match(warnings[0].message, /not a plain number/);
  // Properly quoted fields still work.
  assert.equal(parseCsv('date,resting_heart_rate\n2026-08-01,"62"').readings[0].value, 62);
});

test("only plain decimal numbers are accepted", () => {
  for (const bad of ["0x3e", "0b111110", "1e2", "Infinity", "  62  x", "62%"]) {
    const { readings, warnings } = parseCsv(`date,resting_heart_rate\n2026-08-01,${bad}`);
    assert.equal(readings.length, 0, `"${bad}" must not be accepted`);
    assert.ok(warnings.length > 0, `"${bad}" must warn`);
  }
  // ...and ordinary decimals still are.
  assert.equal(parseCsv("date,resting_heart_rate\n2026-08-01,62.5").readings[0].value, 62.5);
  assert.equal(parseCsv("date,resting_heart_rate\n2026-08-01,.5").readings[0].value, 0.5);
});

test("negative values are refused", () => {
  const { readings, warnings } = parseCsv("date,weight_lb\n2026-08-01,-1000");
  assert.equal(readings.length, 0, "a negative weight is a broken export, not a measurement");
  assert.match(warnings[0].message, /negative/);
});

test("a blank cell is not measured, and is distinguishable from a real zero", () => {
  // Also: a blank must be understood as "not recorded", not reported as a
  // malformed value. Warning on every empty cell would bury the real problems
  // in a file where most metrics are only recorded some days.
  // "0 minutes of activity" and "activity not recorded" mean opposite things:
  // a stored zero would drag the baseline down and could raise a false alert.
  const { readings } = parseCsv(
    ["date,active_minutes", "2026-08-01,", "2026-08-02,0", "2026-08-03,90"].join("\n")
  );
  assert.equal(readings.length, 2, "the blank row produces no reading at all");
  assert.deepEqual(readings.map((r) => r.date), ["2026-08-02", "2026-08-03"]);
  assert.equal(readings[0].value, 0, "an explicit zero IS kept");
  const { warnings } = parseCsv(["date,active_minutes", "2026-08-01,", "2026-08-02,0"].join("\n"));
  assert.deepEqual(warnings, [], "a blank is expected input, not an error");
});

// summarizeImport is what the import screen reads. It is the only account the
// person gets of what happened to their file, so its honesty is load-bearing.
test("the summary reports the range, the day count and the per-metric totals", () => {
  const s = summarizeImport(
    parseCsv(
      [
        "date,resting_heart_rate,night_sleep_minutes",
        "2026-08-01,62,480",
        "2026-08-03,64,",
        "2026-08-02,63,455",
      ].join("\n")
    )
  );
  assert.equal(s.readings, 5);
  assert.equal(s.days, 3);
  assert.equal(s.from, "2026-08-01");
  assert.equal(s.to, "2026-08-03", "range must come from sorted dates, not file order");
  assert.deepEqual(s.byMetric, [
    { metric: "resting_heart_rate", count: 3 },
    { metric: "night_sleep_minutes", count: 2 },
  ]);
});

// Showing ten problems out of four hundred with no sign of the rest would make
// a badly broken export look very nearly clean.
test("a truncated warning list says how many it is hiding", () => {
  const rows = ["date,resting_heart_rate"];
  for (let i = 0; i < 30; i++) rows.push(`2026-08-01,not-a-number`);
  const s = summarizeImport(parseCsv(rows.join("\n")), 10);
  assert.equal(s.warnings.length, 10);
  assert.equal(s.hiddenWarnings, 20);
  assert.equal(s.warnings.length + s.hiddenWarnings, 30, "every warning is accounted for");
});

test("a file with nothing usable summarises as empty rather than throwing", () => {
  const s = summarizeImport(parseCsv("nonsense"));
  assert.equal(s.readings, 0);
  assert.equal(s.days, 0);
  assert.equal(s.from, null);
  assert.equal(s.to, null);
  assert.ok(s.warnings.length > 0, "and says why");
});

test("the summary names every pet in a multi-pet file", () => {
  const s = summarizeImport(
    parseCsv("date,pet,resting_heart_rate\n2026-08-01,Rex,62\n2026-08-01,Bo,70")
  );
  assert.deepEqual(s.pets.sort(), ["Bo", "Rex"]);
  assert.equal(s.readings, 2);
});


// A spreadsheet saying `weight,32` means a 32 lb or 32 kg dog. Read as the
// canonical unit it became 32 grams — a plausible-looking number wrong by three
// orders of magnitude, on the measurement a vet reads most closely. There is no
// way to tell which was meant, so the only safe answer is to refuse.
test("a mass or distance column without a unit is refused, not guessed at", () => {
  for (const header of ["weight", "distance"]) {
    const { readings, warnings } = parseCsv(`date,${header}\n2026-08-01,32`);
    assert.equal(readings.length, 0, `${header} must not be imported`);
    assert.match(warnings[0].message, /needs its unit in the name/);
    assert.match(warnings[0].message, new RegExp(`${header}_`), "and must name the alternatives");
  }
});

test("units that cannot be misread are still accepted bare", () => {
  // A count is a count and a minute is a minute; only mass and distance have a
  // canonical unit nobody would write by hand.
  const { readings } = parseCsv("date,resting_heart_rate,active_minutes\n2026-08-01,62,95");
  assert.equal(readings.length, 2);
});
