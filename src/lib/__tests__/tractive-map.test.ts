import { test } from "node:test";
import assert from "node:assert/strict";
import {
  capabilitiesToMetrics,
  mapBiometric,
  mapDayOverview,
  mapProfileWeight,
  wearMinutes,
} from "../sources/tractive-map";
import { isKnownMetric } from "../metrics";
import { addDays } from "../time";

const PET = "pet-1";
const DATE = "2026-08-05";
const FULL_DAY = 86_400;

test("every metric an adapter emits exists in the registry", () => {
  const readings = [
    ...mapDayOverview("activity", { activityDistribution: [
      { category: "ACTIVE", current: 92 }, { category: "RESTING", current: 500 }, { category: "CALORIES", current: 310 },
    ] }, PET, DATE, FULL_DAY),
    ...mapDayOverview("sleep", {
      nightSleepScore: 78,
      nightSleepInterruptions: { count: 3 },
      overview: { nightSleep: { minutes: 480 }, daySleep: { minutes: 120 }, calm: { minutes: 200 } },
    }, PET, DATE, FULL_DAY),
    ...mapDayOverview("scratch", { secondsScratch: 120, events: { noData: [] } }, PET, DATE, FULL_DAY),
    ...mapDayOverview("bark", { average: 12 }, PET, DATE, FULL_DAY),
    ...mapProfileWeight({ details: { weight: 14515 } }, PET, DATE),
  ];
  assert.ok(readings.length > 0);
  for (const r of readings) {
    assert.ok(isKnownMetric(r.metric), `adapter emitted unknown metric "${r.metric}"`);
    assert.ok(Number.isFinite(r.value), `${r.metric} is not finite`);
  }
});

test("activity categories map to distinct metrics", () => {
  const out = mapDayOverview("activity", {
    activityDistribution: [
      { category: "ACTIVE", current: 92 },
      { category: "RESTING", current: 500 },
      { category: "CALORIES", current: 310 },
    ],
  }, PET, DATE, FULL_DAY);
  assert.equal(out.find((r) => r.metric === "active_minutes")?.value, 92);
  assert.equal(out.find((r) => r.metric === "rest_minutes")?.value, 500);
  assert.equal(out.find((r) => r.metric === "calories")?.value, 310);
});

test("scratch seconds are converted to canonical minutes", () => {
  const out = mapDayOverview("scratch", { secondsScratch: 120, events: { noData: [] } }, PET, DATE, FULL_DAY);
  assert.equal(out.find((r) => r.metric === "scratching")?.value, 2, "120s is 2 minutes, not 120");
});

test("wear time uses the day's real length, not a hardcoded 24h", () => {
  // A fully worn collar on a 23-hour spring-forward day.
  assert.equal(wearMinutes([], 23 * 3600), 23 * 60);
  assert.equal(wearMinutes([], 25 * 3600), 25 * 60);
  // Six hours off a normal day.
  assert.equal(wearMinutes([{ durationSeconds: 6 * 3600 }], FULL_DAY), 18 * 60);
  // Gaps longer than the day cannot produce negative wear.
  assert.equal(wearMinutes([{ durationSeconds: 999_999 }], FULL_DAY), 0);
});

test("missing and malformed fields are skipped, not coerced", () => {
  assert.deepEqual(mapDayOverview("sleep", {}, PET, DATE, FULL_DAY), []);
  assert.deepEqual(mapDayOverview("activity", null, PET, DATE, FULL_DAY), []);
  assert.deepEqual(
    mapDayOverview("sleep", { nightSleepScore: "78", nightSleepInterruptions: null }, PET, DATE, FULL_DAY),
    [],
    "a string must not become a number"
  );
  assert.deepEqual(mapDayOverview("bark", { average: NaN }, PET, DATE, FULL_DAY), []);
});

test("a zero reading is kept — zero activity is data, not absence", () => {
  const out = mapDayOverview("activity", { activityDistribution: [{ category: "ACTIVE", current: 0 }] }, PET, DATE, FULL_DAY);
  assert.equal(out.length, 1);
  assert.equal(out[0].value, 0);
});

test("biometric lookback backfills earlier days", () => {
  const out = mapBiometric(
    { average: 62, lookback: { days: [
      { dayOffset: 0, average: 62 }, { dayOffset: -1, average: 61 }, { dayOffset: -2, average: null },
    ] } },
    "resting_heart_rate", PET, DATE, addDays
  );
  assert.equal(out.length, 2, "a null average is skipped");
  assert.deepEqual(out.map((r) => r.date), ["2026-08-05", "2026-08-04"]);
});

test("the top-level average is not written twice when the lookback covers today", () => {
  const withToday = mapBiometric(
    { average: 62, lookback: { days: [{ dayOffset: 0, average: 62 }] } },
    "resting_heart_rate", PET, DATE, addDays
  );
  assert.equal(withToday.filter((r) => r.date === DATE).length, 1);

  const withoutToday = mapBiometric(
    { average: 62, lookback: { days: [{ dayOffset: -1, average: 61 }] } },
    "resting_heart_rate", PET, DATE, addDays
  );
  assert.equal(withoutToday.filter((r) => r.date === DATE).length, 1, "falls back when the lookback misses today");
});

test("profile weight is grams, the canonical mass unit", () => {
  const out = mapProfileWeight({ details: { weight: 14515 } }, PET, DATE);
  assert.deepEqual(out, [{ petKey: PET, date: DATE, metric: "weight", value: 14515 }]);
  assert.deepEqual(mapProfileWeight({ details: { weight: 0 } }, PET, DATE), [], "zero is not a weight");
  assert.deepEqual(mapProfileWeight({}, PET, DATE), []);
});

test("capabilities gate which metrics a tracker claims", () => {
  const full = capabilitiesToMetrics(["VITALITY_TRACKING", "SLEEP_TRACKING", "BARK_DETECTION", "SCRATCH_DETECTION"]);
  assert.ok(full.includes("resting_heart_rate"));
  assert.ok(full.includes("barking_events"));

  const basic = capabilitiesToMetrics([]);
  assert.ok(!basic.includes("resting_heart_rate"), "an older tracker must not claim heart rate");
  assert.ok(!basic.includes("barking_events"));
  assert.ok(basic.includes("active_minutes"), "every tracker reports activity");

  for (const m of full) assert.ok(isKnownMetric(m), `capability produced unknown metric "${m}"`);
  assert.equal(new Set(full).size, full.length, "no duplicates");
});
