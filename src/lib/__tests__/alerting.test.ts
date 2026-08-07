import { test } from "node:test";
import assert from "node:assert/strict";
import { detectDeviation, recentWithinBand, hasSufficientHistory, type DayPoint } from "../baseline";
import { alertSeries, isAlertVisible, isCurrent, missingDays, shouldWithdraw } from "../alerting";

const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);
const J = [0, 1, -1, 2, -2];
const steady = (base: number, days: number): DayPoint[] =>
  Array.from({ length: days }, (_, i) => ({ date: day(i), value: base + J[i % 5] }));

test("an alert is withdrawn only on evidence the metric is normal", () => {
  const today = day(62);
  const normal = steady(62, 62); // deep, current, unremarkable history
  assert.equal(shouldWithdraw(normal, false, today, "high_bad"), true, "current normal data withdraws");
  assert.equal(shouldWithdraw(normal, true, today, "high_bad"), false, "a live deviation never withdraws");
});

test("thin history after a gap does not withdraw a standing alert", () => {
  // One fresh reading, nothing behind it. detectDeviation returns null here for
  // want of a baseline, not because the dog is fine — withdrawing on that would
  // delete a real alert precisely when data has just come back.
  const today = day(62);
  const thin: DayPoint[] = [{ date: day(10), value: 62 }, { date: today, value: 140 }];
  assert.equal(shouldWithdraw(thin, false, today, "high_bad"), false);
});

test("stale data never withdraws", () => {
  const today = day(100);
  const stale = steady(62, 62); // newest reading is day(61), long past
  assert.equal(shouldWithdraw(stale, false, today, "high_bad"), false, "silence is not recovery");
});

test("withdrawal tolerates an empty series without throwing", () => {
  assert.equal(shouldWithdraw([], false, day(62), "high_bad"), false);
});

test("a fresh but still-abnormal reading does not withdraw the alert", () => {
  // The exact case a review reproduced. A wear-sensitive metric: 60 normal
  // days, two genuinely low days, two low-wear days that get filtered out,
  // then one fresh reading that is still abnormally low.
  //
  // detectDeviation returns null here — only one qualifying point remains in
  // the three-day window, so the 2-of-3 rule cannot be met. That null means
  // "cannot tell", not "recovered", and withdrawing on it cleared a warning
  // while the dog's activity was still collapsed.
  const today = day(66);
  const lowWear = new Set([day(63), day(64)]);
  const raw: DayPoint[] = [
    ...steady(90, 60),
    { date: day(61), value: 20 }, // genuinely low
    { date: day(62), value: 19 }, // genuinely low
    { date: day(63), value: 8 },  // collar off — filtered
    { date: day(64), value: 7 },  // collar off — filtered
    { date: day(65), value: 21 }, // fresh, STILL abnormally low
  ];
  const series = alertSeries(raw, "active_minutes", { today, lowWear });

  const dev = detectDeviation(series, "active_minutes", "low_bad");
  assert.equal(dev, null, "precondition: the 2-of-3 rule cannot be met here");
  assert.equal(
    shouldWithdraw(series, dev !== null, today, "low_bad"),
    false,
    "must not clear an alert while the newest reading is still outside the band"
  );
});

test("recentWithinBand demands current readings inside the range", () => {
  const normal = steady(62, 62);
  assert.equal(recentWithinBand(normal, "high_bad"), true);

  const stillHigh = [...steady(62, 60), { date: day(61), value: 140 }];
  assert.equal(recentWithinBand(stillHigh, "high_bad"), false);
  // A high reading is irrelevant when only lows are concerning.
  assert.equal(recentWithinBand(stillHigh, "low_bad"), true);
  assert.equal(recentWithinBand(stillHigh, "both"), false);

  // Not enough history is not evidence of normality.
  assert.equal(recentWithinBand(steady(62, 5), "high_bad"), false);
  assert.equal(recentWithinBand([], "high_bad"), false);
});

test("a persistent condition keeps producing a currently-dated alert", () => {
  // Why an old, already-emailed alert row aging off the dashboard is safe: if
  // the condition is STILL active, detection anchors to the newest offending
  // day, so a fresh row exists at a current date. The old row is history, not
  // a lost warning. If this ever stopped holding, a long-running deviation
  // could become invisible.
  const base = steady(62, 60);
  for (const extraDays of [2, 10, 30]) {
    const ongoing = [
      ...base,
      ...Array.from({ length: extraDays }, (_, i) => ({ date: day(60 + i), value: 140 })),
    ];
    const dev = detectDeviation(ongoing, "resting_heart_rate", "high_bad");
    assert.ok(dev, `no deviation after ${extraDays} days of it`);
    assert.equal(
      dev.date,
      day(60 + extraDays - 1),
      "the alert must be dated to the newest offending day, not the first"
    );
  }
});

test("a deviation that ends stops being detected", () => {
  const series = [
    ...steady(62, 60),
    { date: day(60), value: 140 },
    { date: day(61), value: 140 },
    { date: day(62), value: 62 },
    { date: day(63), value: 63 },
    { date: day(64), value: 61 },
  ];
  assert.equal(detectDeviation(series, "resting_heart_rate", "high_bad"), null);
  // ...and the recovery is positively confirmed, so the alert can be withdrawn.
  assert.equal(recentWithinBand(series, "high_bad"), true);
  assert.equal(shouldWithdraw(series, false, day(64), "high_bad"), true);
});
test("a resolved alert is never shown as a current warning", () => {
  const today = "2026-08-20";
  const base = { date: today, emailed: false, acknowledged: false, resolved: true };
  assert.equal(isAlertVisible(base, today), false, "even when recent and undelivered");
  assert.equal(isAlertVisible({ ...base, emailed: true }, today), false);
});

test("recent alerts are shown; old delivered ones age off", () => {
  const today = "2026-08-20";
  const live = { emailed: true, acknowledged: false, resolved: false };
  assert.equal(isAlertVisible({ ...live, date: "2026-08-20" }, today), true);
  assert.equal(isAlertVisible({ ...live, date: "2026-08-06" }, today), true, "14 days is inside");
  assert.equal(isAlertVisible({ ...live, date: "2026-08-05" }, today), false, "15 days is out");
});

test("an undelivered alert is visible at any age", () => {
  // The whole point: nothing may be both impossible to deliver and invisible.
  const today = "2026-08-20";
  const undelivered = { date: "2025-01-01", emailed: false, acknowledged: false, resolved: false };
  assert.equal(isAlertVisible(undelivered, today), true);
});

test("a dismissed alert does not return through the undelivered clause", () => {
  const today = "2026-08-20";
  const dismissed = { date: "2025-01-01", emailed: false, acknowledged: true, resolved: false };
  assert.equal(isAlertVisible(dismissed, today), false);
  // ...but dismissing a recent one still hides it only after the display window.
  assert.equal(isAlertVisible({ ...dismissed, date: today }, today), true, "recent rows show regardless; the panel greys them out");
});

// -------------------------------------------- reported by external review



