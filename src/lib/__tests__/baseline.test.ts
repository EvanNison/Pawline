import { test } from "node:test";
import assert from "node:assert/strict";
import { detectDeviation, rollingBaseline, computeBaseline, band, DayPoint } from "../baseline";

const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * Steady readings with realistic jitter.
 *
 * The spread must come from a distribution where fewer than half the values sit
 * exactly on the median — otherwise MAD is 0, the degenerate-spread floor takes
 * over, and the fixture stops resembling real biometric data. This 5-value
 * cycle gives median 62, MAD 1, sMAD 1.4826.
 */
const JITTER = [0, 1, -1, 2, -2];
function steadyHistory(base = 62, days = 60): DayPoint[] {
  return Array.from({ length: days }, (_, i) => ({ date: day(i), value: base + JITTER[i % 5] }));
}

test("computeBaseline needs at least two values", () => {
  assert.equal(computeBaseline([]), null);
  assert.equal(computeBaseline([62]), null);
  assert.ok(computeBaseline([62, 63]));
});

test("scaled MAD is not dragged by a single extreme outlier", () => {
  const clean = computeBaseline([60, 61, 62, 63, 64])!;
  const withOutlier = computeBaseline([60, 61, 62, 63, 64, 900])!;
  // Median barely moves and the robust spread stays in the same order of
  // magnitude — the whole reason for MAD over standard deviation.
  assert.ok(Math.abs(withOutlier.median - clean.median) <= 1);
  assert.ok(withOutlier.smad < clean.smad * 3);
});

test("constant history still yields a usable band", () => {
  const base = computeBaseline(Array(30).fill(62))!;
  assert.equal(base.smad, 0);
  const b = band(base);
  assert.ok(b.high > base.median, "spread floor must prevent a zero-width band");
  assert.ok(b.low < base.median);
});

test("two spikes on consecutive days raise an alert", () => {
  const series = [...steadyHistory(), { date: day(60), value: 95 }, { date: day(61), value: 96 }];
  const d = detectDeviation(series, "resting_heart_rate", "high_bad");
  assert.ok(d, "expected a deviation");
  assert.equal(d.direction, "high");
  assert.equal(d.daysOutside, 2);
  assert.equal(d.date, day(61), "reports the most recent offending day");
});

test("two spikes 20 days apart do NOT alert (the collection-gap bug)", () => {
  // Under an index-based window these are "2 of the last 3 readings" and fire.
  const series = [...steadyHistory(), { date: day(60), value: 95 }, { date: day(80), value: 96 }];
  assert.equal(detectDeviation(series, "resting_heart_rate", "high_bad"), null);
});

test("a single spike does not alert", () => {
  const series = [...steadyHistory(), { date: day(60), value: 95 }];
  assert.equal(detectDeviation(series, "resting_heart_rate", "high_bad"), null);
});

test("direction is respected", () => {
  const low = [...steadyHistory(), { date: day(60), value: 10 }, { date: day(61), value: 11 }];
  assert.equal(detectDeviation(low, "active_minutes", "high_bad"), null, "a drop is not a high_bad event");
  assert.ok(detectDeviation(low, "active_minutes", "low_bad"));
  assert.ok(detectDeviation(low, "resting_heart_rate", "both"));
});

test("insufficient history yields no opinion", () => {
  const series = [...steadyHistory(62, 10), { date: day(10), value: 95 }, { date: day(11), value: 96 }];
  assert.equal(detectDeviation(series, "resting_heart_rate", "high_bad"), null);
});

test("history sparse in calendar terms does not qualify", () => {
  // 30 readings, but spread one per 10 days: only a handful fall inside the
  // 60-day baseline window, so there is not enough recent history to judge.
  const sparse: DayPoint[] = Array.from({ length: 30 }, (_, i) => ({ date: day(i * 10), value: 62 + (i % 2) }));
  const series = [...sparse, { date: day(300), value: 95 }, { date: day(301), value: 96 }];
  assert.equal(detectDeviation(series, "resting_heart_rate", "high_bad"), null);
});

test("severity escalates with distance from baseline", () => {
  // Baseline median 62, sMAD 1.4826 -> band tops out at 66.4.
  // 67 is z=3.4 (outside, but "watch"); 140 is z=52 ("alert").
  const mild = [...steadyHistory(), { date: day(60), value: 67 }, { date: day(61), value: 67 }];
  const severe = [...steadyHistory(), { date: day(60), value: 140 }, { date: day(61), value: 140 }];
  assert.equal(detectDeviation(mild, "resting_heart_rate", "high_bad")?.severity, "watch");
  assert.equal(detectDeviation(severe, "resting_heart_rate", "high_bad")?.severity, "alert");
});

test("degenerate (constant) history widens the band instead of alerting on noise", () => {
  // A perfectly flat history has sMAD 0. Without the spread floor every later
  // reading would be infinitely deviant; with it, small wobble is tolerated.
  const flat: DayPoint[] = Array.from({ length: 60 }, (_, i) => ({ date: day(i), value: 62 }));
  const wobble = [...flat, { date: day(60), value: 66 }, { date: day(61), value: 66 }];
  assert.equal(detectDeviation(wobble, "resting_heart_rate", "high_bad"), null);
  const real = [...flat, { date: day(60), value: 120 }, { date: day(61), value: 120 }];
  assert.ok(detectDeviation(real, "resting_heart_rate", "high_bad"));
});

test("rollingBaseline withholds a band until there is enough history", () => {
  const series = steadyHistory(62, 90);
  const bands = rollingBaseline(series);
  assert.equal(bands[5], null, "no band from a handful of readings");
  assert.equal(bands[bands.length - 1] !== null, true, "band once history is deep enough");
  // The invariant that matters: no band is ever built from fewer than
  // MIN_BASELINE_DAYS of history. (On a gapless series the first one lands at
  // index 23 — 21 days of history ending 3 days before the point.)
  for (const [i, b] of bands.entries()) {
    if (b) assert.ok(b.count >= 21, `band at index ${i} built from only ${b.count} days`);
  }
  assert.equal(bands.findIndex((b) => b !== null), 23);
});

test("rollingBaseline excludes the detection window from its own baseline", () => {
  // A run of high values at the end must not inflate the band drawn behind them.
  const series = [...steadyHistory(62, 80), ...Array.from({ length: 3 }, (_, i) => ({ date: day(80 + i), value: 200 }))];
  const bands = rollingBaseline(series);
  const last = bands[bands.length - 1]!;
  // `< 70` was too weak to fail: with only three 200s among sixty readings the
  // median stays near 62 even when exclusion is broken. Pin it to the actual
  // undisturbed baseline.
  assert.ok(
    Math.abs(last.median - 62) <= 1,
    `baseline should be the pre-spike normal, got ${last.median}`
  );
  // And the spike days must genuinely be outside the window it was built from.
  assert.equal(last.count, 60, "the three detection-window days are excluded");
});

test("the baseline window is BASELINE_WINDOW calendar days, inclusive", () => {
  // The exact off-by-one that shipped in the predecessor: an exclusive lower
  // bound made the window 59 days instead of 60, so a metric with just enough
  // history stayed silent. Pawline had the fix but nothing guarding it.
  const anchor = 100;
  const pts: DayPoint[] = Array.from({ length: 21 }, (_, i) => ({
    date: day(anchor - 62 + i),
    value: 62 + JITTER[i % 5],
  }));
  pts.push({ date: day(anchor - 1), value: 200 }, { date: day(anchor), value: 200 });
  assert.ok(
    detectDeviation(pts, "resting_heart_rate", "high_bad"),
    "the reading exactly BASELINE_WINDOW + DETECTION_WINDOW - 1 days back must count"
  );
  assert.equal(
    detectDeviation(pts.slice(1), "resting_heart_rate", "high_bad"),
    null,
    "one day fewer is not enough history"
  );
});

test("a flat history does not produce a band so wide it hides real change", () => {
  // A tracker reporting whole numbers can sit on one value for weeks, making
  // MAD exactly zero. A fallback of "10% of the median" then accepted 42-78 bpm
  // for a dog whose normal is 60, so a sustained rise to 75 raised nothing —
  // the precise failure this app exists to prevent.
  const flat: DayPoint[] = Array.from({ length: 60 }, (_, i) => ({ date: day(i), value: 60 }));
  const risen = [...flat, { date: day(60), value: 75 }, { date: day(61), value: 75 }];
  assert.ok(detectDeviation(risen, "resting_heart_rate", "both"), "a 25% sustained rise must alert");

  const wobble = [...flat, { date: day(60), value: 61 }, { date: day(61), value: 61 }];
  assert.equal(detectDeviation(wobble, "resting_heart_rate", "both"), null, "rounding wobble must not");

  const b = computeBaseline(flat.map((p) => p.value))!;
  assert.equal(b.smad, 0, "precondition: scaled MAD is degenerate here");
  assert.ok(band(b).high < 68, `band should be tight for a flat history, got ${band(b).high}`);
});

test("with zero MAD, the band still tracks how spread out the data is", () => {
  // sMAD is zero whenever at least half the deviations are zero, not only for
  // perfectly constant data. The fallback must reflect the ACTUAL dispersion —
  // a fixed percentage floor would give these two identical bands despite one
  // being far more variable than the other.
  const tight = Array.from({ length: 60 }, (_, i) => (i < 40 ? 60 : 62));
  const loose = Array.from({ length: 60 }, (_, i) => (i < 40 ? 60 : 90));
  const bTight = computeBaseline(tight)!;
  const bLoose = computeBaseline(loose)!;
  assert.equal(bTight.smad, 0, "precondition: both are degenerate for MAD");
  assert.equal(bLoose.smad, 0);
  assert.equal(bTight.median, bLoose.median, "and share a median, so only spread differs");

  const wTight = band(bTight).high - bTight.median;
  const wLoose = band(bLoose).high - bLoose.median;
  assert.ok(wLoose > wTight * 3, `spread must track dispersion: ${wTight} vs ${wLoose}`);
});
