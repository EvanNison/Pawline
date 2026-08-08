import { test } from "node:test";
import assert from "node:assert/strict";
import type { DayPoint } from "../baseline";
import { buildYoY, pctChange, rollingAvg, totalSleepSeries } from "../trends";

const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString().slice(0, 10);

test("rolling average spans calendar days, not array positions", () => {
  // A "30-day average" that slices 30 entries spans 45 calendar days after a
  // 15-day outage, mixing pre-outage readings into a window labelled 30 days —
  // which delays and dilutes a real decline.
  const series: DayPoint[] = [
    ...Array.from({ length: 15 }, (_, i) => ({ date: day(i), value: 100 })),
    ...Array.from({ length: 15 }, (_, i) => ({ date: day(60 + i), value: 50 })),
  ];
  assert.equal(rollingAvg(series, 30, 7).at(-1)!.value, 50, "pre-outage values must not leak in");
});

test("rolling average refuses to average too few days", () => {
  const series: DayPoint[] = Array.from({ length: 4 }, (_, i) => ({ date: day(i), value: 10 }));
  assert.deepEqual(rollingAvg(series, 30, 7), [], "four days is not a 30-day average");
});

test("total sleep requires both components, never a partial sum", () => {
  // A day with 240 minutes of day sleep and no night reading reported as "240
  // total" is a badly low number presented as a complete one, which then skews
  // averages and the year-over-year comparison in the vet report.
  const night: DayPoint[] = [{ date: day(1), value: 400 }, { date: day(2), value: 420 }];
  const dayS: DayPoint[] = [{ date: day(1), value: 100 }];
  assert.deepEqual(totalSleepSeries(night, dayS), [{ date: day(1), value: 500 }]);
  assert.deepEqual(totalSleepSeries(undefined, dayS), []);
  assert.deepEqual(totalSleepSeries(night, []), []);
  assert.deepEqual(totalSleepSeries(night, undefined), []);
});

test("percent change guards against a zero or missing baseline", () => {
  assert.equal(pctChange(50, 100), -50);
  assert.equal(pctChange(150, 100), 50);
  assert.equal(pctChange(null, 100), null);
  assert.equal(pctChange(50, null), null);
  assert.equal(pctChange(50, 0), null, "dividing by a zero baseline is not a 'change'");
});

test("year-over-year aligns by month-day and spans a full year", () => {
  const series: DayPoint[] = [
    { date: "2025-08-08", value: 10 },
    { date: "2026-08-08", value: 20 },
  ];
  const rows = buildYoY(series, "2026-08-08");
  const today = rows.at(-1)!;
  assert.equal(today.md, "08-08");
  assert.equal(today.thisYear, 20);
  assert.equal(today.lastYear, 10);
  assert.ok(rows.length >= 364 && rows.length <= 365);
});

test("year-over-year reports a missing side as null rather than zero", () => {
  // Zero is a reading. Absent is not, and a chart that draws them alike invents
  // a year-on-year collapse out of a gap in collection.
  const rows = buildYoY([{ date: "2026-08-08", value: 20 }], "2026-08-08");
  const today = rows.at(-1)!;
  assert.equal(today.thisYear, 20);
  assert.equal(today.lastYear, null);
});

test("leap day is excluded rather than aligned against nothing", () => {
  const rows = buildYoY([{ date: "2026-02-28", value: 5 }], "2026-08-08");
  assert.ok(!rows.some((r) => r.md === "02-29"));
});
