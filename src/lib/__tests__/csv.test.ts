import { test } from "node:test";
import assert from "node:assert/strict";
import { CsvSource, parseCsv } from "../sources/csv";

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
  assert.match(warnings[0].message, /not a number/);
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
