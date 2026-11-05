/**
 * Composite indicators: Vitals check, Readiness, Itch & comfort, long-term
 * drift and journal context. These sit on top of the single-metric alerts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import type { DayPoint } from "../baseline";
import {
  readingOn, vitalsOn, comfortOn, readinessOn, flaggedStreak, subScore,
  longTrend, monthlyMedians, contextFor, describeComposite, CompositeDay,
} from "../composites";

const day = (n: number) => new Date(Date.UTC(2026, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);
const J = [0, 1, -1, 2, -2];
/** `days` days of jittered readings around `base`, optionally overriding the tail. */
const series = (base: number, days: number, tail: number[] = []): DayPoint[] =>
  Array.from({ length: days }, (_, i) => {
    const t = i - (days - tail.length);
    return { date: day(i), value: t >= 0 ? tail[t] : base + J[i % 5] };
  });

const N = 80;
const last = day(N - 1);
const normalMap = () =>
  new Map<string, DayPoint[]>([
    ["resting_heart_rate", series(60, N)],
    ["resting_respiratory_rate", series(13, N)],
    ["sleep_interruptions", series(10, N)],
    ["active_minutes", series(100, N)],
    ["scratching", series(30, N)],
  ]);

test("a normal day is normal and scores high", () => {
  const m = normalMap();
  assert.equal(vitalsOn(m, last).level, "normal");
  const r = readinessOn(m, last)!;
  assert.ok(r.score >= 90, `score ${r.score}`);
  assert.equal(r.band, "good");
});

test("one vital off is 'one', not a composite flag", () => {
  const m = normalMap();
  m.set("resting_heart_rate", series(60, N, [80]));
  const v = vitalsOn(m, last);
  assert.equal(v.level, "one");
  assert.equal(v.off[0].metric, "resting_heart_rate");
});

test("heart AND breathing up together is an alert", () => {
  const m = normalMap();
  m.set("resting_heart_rate", series(60, N, [80]));
  m.set("resting_respiratory_rate", series(13, N, [22]));
  const v = vitalsOn(m, last);
  assert.equal(v.level, "alert");
  assert.equal(v.off.length, 2);
  assert.ok((readinessOn(m, last)?.score ?? 100) < 60);
});

test("two non-core signals off is a watch", () => {
  const m = normalMap();
  m.set("sleep_interruptions", series(10, N, [30]));
  m.set("active_minutes", series(100, N, [20]));
  assert.equal(vitalsOn(m, last).level, "watch");
});

test("only the worrying side counts: low heart rate and high activity are not 'off'", () => {
  const m = normalMap();
  m.set("resting_heart_rate", series(60, N, [40]));
  m.set("active_minutes", series(100, N, [250]));
  assert.equal(vitalsOn(m, last).level, "normal");
});

test("missing history is unknown, never normal", () => {
  const m = new Map<string, DayPoint[]>([
    ["resting_heart_rate", series(60, 10)],
    ["resting_respiratory_rate", series(13, 10)],
  ]);
  assert.equal(vitalsOn(m, day(9)).level, "unknown");
  assert.equal(readinessOn(m, day(9)), null);
  assert.equal(readingOn(m.get("resting_heart_rate"), { metric: "resting_heart_rate", label: "x", bad: "high" }, "2030-01-01"), null);
});

test("the day being judged and the two before it are not in its own baseline", () => {
  // A 3-day climb must not soften its own judgement.
  const m = normalMap();
  m.set("resting_heart_rate", series(60, N, [80, 80, 80]));
  m.set("resting_respiratory_rate", series(13, N, [22, 22, 22]));
  assert.equal(vitalsOn(m, last).level, "alert");
});

test("itch & comfort: scratching plus restless nights", () => {
  const m = normalMap();
  m.set("scratching", series(30, N, [120]));
  m.set("sleep_interruptions", series(10, N, [30]));
  assert.equal(comfortOn(m, last).level, "watch");
  m.set("sleep_interruptions", series(10, N));
  assert.equal(comfortOn(m, last).level, "one");
});

test("subScore: flat inside 1 spread, zero by 4", () => {
  assert.equal(subScore(0), 100);
  assert.equal(subScore(1), 100);
  assert.equal(Math.round(subScore(2.5)), 50);
  assert.equal(subScore(4), 0);
  assert.equal(subScore(9), 0);
});

test("flaggedStreak counts consecutive flagged days and skips unknown ones", () => {
  const d = (level: CompositeDay["level"]): CompositeDay => ({ date: "x", checked: 4, off: [], level });
  assert.equal(flaggedStreak([d("alert"), d("normal"), d("watch"), d("unknown"), d("alert")]), 2);
  assert.equal(flaggedStreak([d("watch"), d("one")]), 0);
});

test("longTrend compares against a year earlier and ignores the last 3 weeks", () => {
  const pts: DayPoint[] = [];
  for (let i = 0; i < 500; i++) {
    const v = i < 250 ? 12 : 15;
    pts.push({ date: day(i), value: i > 480 ? 30 : v }); // a recent spike must not count
  }
  const t = longTrend(pts, day(499))!;
  assert.equal(t.earlier, 12);
  assert.equal(t.recent, 15);
  assert.equal(t.direction, "up");
  assert.equal(t.earlierLabel, "a year earlier");
});

test("longTrend is null without enough separation, flat within tolerance", () => {
  assert.equal(longTrend(series(13, 120), day(119)), null);
  const pts = Array.from({ length: 400 }, (_, i) => ({ date: day(i), value: 13 + (i % 2) * 0.2 }));
  assert.equal(longTrend(pts, day(399))?.direction, "flat");
  // 3% tolerance: a 1 bpm wobble on 62 is steady.
  const hr = Array.from({ length: 400 }, (_, i) => ({ date: day(i), value: i < 200 ? 62 : 61 }));
  assert.equal(longTrend(hr, day(399))?.direction, "flat");
});

test("monthlyMedians drops thin months", () => {
  const pts = [...series(13, 45), { date: "2026-03-01", value: 99 }]; // Jan 31d, Feb 14d, Mar 1d
  const months = monthlyMedians(pts);
  assert.deepEqual(months.map((m) => m.month), ["2026-01", "2026-02"]);
});

test("contextFor covers a stay and the few days after it", () => {
  const stay = { date: "2026-10-20", end_date: "2026-10-27", category: "boarding", note: "sitter" };
  const vet = { date: "2026-10-01", category: "vet", note: "checkup" };
  assert.equal(contextFor([stay, vet], "2026-10-24").length, 1);
  assert.equal(contextFor([stay], "2026-10-30").length, 1);
  assert.equal(contextFor([stay], "2026-10-31").length, 0);
  assert.equal(contextFor([stay], "2026-10-19").length, 0);
  assert.equal(contextFor([vet], "2026-10-01").length, 1);
});

test("describeComposite is a readable sentence", () => {
  const m = normalMap();
  m.set("resting_heart_rate", series(60, N, [80]));
  m.set("resting_respiratory_rate", series(13, N, [22]));
  const s = describeComposite(vitalsOn(m, last), (k) => (k === "resting_heart_rate" ? "bpm" : "brpm"));
  assert.match(s, /^2 vitals off together: resting heart rate up \(80 bpm vs usual 60\), breathing rate up \(22 brpm vs usual 13\)\.$/);
});
