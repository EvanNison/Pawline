import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChart, MAX_BAND_CARRY_DAYS } from "../chart";
import type { DayPoint } from "../baseline";

const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);
const J = [0, 1, -1, 2, -2];
const steady = (base: number, days: number): DayPoint[] =>
  Array.from({ length: days }, (_, i) => ({ date: day(i), value: base + J[i % 5] }));

test("a band never claims a physically impossible range", () => {
  // Seen on the predecessor's live dashboard: a "usual range" for nightly
  // wakeups reaching -10, and one for a score out of 100 reaching 140.
  const noisy: DayPoint[] = Array.from({ length: 60 }, (_, i) => ({
    date: day(i),
    value: [2, 18, 5, 14, 9][i % 5],
  }));
  const dates = noisy.map((p) => p.date);

  for (const p of buildChart("sleep_interruptions", noisy, dates, { units: "metric" }).points) {
    if (p.baseLow !== null) assert.ok(p.baseLow >= 0, `wakeups band went to ${p.baseLow}`);
  }
  for (const p of buildChart("sleep_score", noisy, dates, { units: "metric" }).points) {
    if (p.baseHigh !== null) assert.ok(p.baseHigh <= 100, `score band went to ${p.baseHigh}`);
  }
});

test("a still-accruing day is drawn as a gap, not a collapse", () => {
  const series: DayPoint[] = [
    ...Array.from({ length: 30 }, (_, i) => ({ date: day(i), value: 480 })),
    { date: day(30), value: 12 }, // today, barely started
  ];
  const dates = series.map((p) => p.date);
  const guarded = buildChart("night_sleep_minutes", series, dates, {
    units: "metric",
    incompleteDates: new Set([day(30)]),
  }).points;
  assert.equal(guarded.at(-1)!.value, null, "today must not be plotted as 12 minutes");
  assert.equal(guarded.at(-2)!.value, 480);

  // Without the guard the misleading value IS drawn — proving the guard matters.
  const unguarded = buildChart("night_sleep_minutes", series, dates, { units: "metric" }).points;
  assert.equal(unguarded.at(-1)!.value, 12);
});

test("values and bands are converted to the chosen unit system", () => {
  // 14515 g is 32.0 lb / 14.52 kg. Storage stays canonical either way.
  const series: DayPoint[] = Array.from({ length: 40 }, (_, i) => ({ date: day(i), value: 14515 + J[i % 5] }));
  const dates = series.map((p) => p.date);
  const metric = buildChart("weight", series, dates, { units: "metric" });
  const imperial = buildChart("weight", series, dates, { units: "imperial" });
  assert.equal(metric.unit, "kg");
  assert.equal(imperial.unit, "lb");
  assert.ok(Math.abs(metric.points.at(-1)!.value! - 14.52) < 0.05, `${metric.points.at(-1)!.value}`);
  assert.ok(Math.abs(imperial.points.at(-1)!.value! - 32.0) < 0.05, `${imperial.points.at(-1)!.value}`);
  // The band travels with the values, or the chart contradicts itself.
  assert.ok(metric.points.at(-1)!.baseMid! < 20, "band must be in kg too");
  assert.ok(imperial.points.at(-1)!.baseMid! > 20, "band must be in lb too");
});

test("low wear shapes the band only for totals", () => {
  const series: DayPoint[] = [
    ...steady(90, 60),
    ...Array.from({ length: 40 }, (_, i) => ({ date: day(60 + i), value: 5 })),
  ];
  const dates = Array.from({ length: 100 }, (_, i) => day(i));
  const lowWear = new Set(Array.from({ length: 40 }, (_, i) => day(60 + i)));

  const totals = buildChart("active_minutes", series, dates, {
    units: "metric", lowWearDates: lowWear, excludeLowWearFromBand: true,
  }).points;
  const averages = buildChart("resting_heart_rate", series, dates, {
    units: "metric", lowWearDates: lowWear, excludeLowWearFromBand: false,
  }).points;

  // A total's band is either the true normal or honestly null — never dragged
  // to the collar-off value.
  for (const p of totals) {
    if (p.baseMid !== null) assert.ok(p.baseMid > 50, `band dragged to ${p.baseMid}`);
  }
  // An average's band follows its data, because every reading is valid.
  assert.equal(averages.at(-1)!.baseMid, 5);
  // Readings are plotted and flagged either way.
  assert.equal(totals.at(-1)!.value, 5);
  assert.equal(totals.at(-1)!.lowWear, true);
});

test("a band is not resurrected once its evidence runs out", () => {
  const series = steady(62, 40);
  const dates = [...series.map((p) => p.date), day(200)];
  const far = buildChart("resting_heart_rate", series, dates, { units: "metric" }).points
    .find((p) => p.date === day(200))!;
  assert.equal(far.baseMid, null, "a months-old band must not be carried forward");
  assert.equal(MAX_BAND_CARRY_DAYS, 14);
});

test("bands are null before there is enough history, not zero-width", () => {
  const series = steady(62, 5);
  const points = buildChart("resting_heart_rate", series, series.map((p) => p.date), { units: "metric" }).points;
  assert.ok(points.every((p) => p.baseMid === null && p.baseLow === null && p.baseHigh === null));
});
