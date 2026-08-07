import { test } from "node:test";
import assert from "node:assert/strict";
import { datesToCollect, runOutcome, settledDays, type PlanOptions, type StoredDay } from "../collector";
import { midnightEpoch, addDays } from "../time";

const TZ = "America/New_York";
const TODAY = "2026-08-20";
const opts = (over: Partial<PlanOptions> = {}): PlanOptions => ({
  today: TODAY,
  window: 14,
  limit: 8,
  probeCount: 3,
  dayEndEpoch: (d) => midnightEpoch(addDays(d, 1), TZ),
  ...over,
});
/** A day recorded properly, after it finished. */
const settled = (date: string): StoredDay => ({
  date,
  metricCount: 3,
  lastWriteEpoch: midnightEpoch(addDays(date, 1), TZ) + 600,
});
/** A day captured minutes after midnight and never revisited. */
const provisional = (date: string): StoredDay => ({
  date,
  metricCount: 3,
  lastWriteEpoch: midnightEpoch(date, TZ) + 660,
});

test("a day written before it ended is not settled, however complete it looks", () => {
  // The 2026-08-05 failure exactly: all three probes present, every value zero,
  // captured eleven minutes past midnight and never overwritten.
  const s = settledDays([provisional("2026-08-10")], opts());
  assert.equal(s.has("2026-08-10"), false);
  assert.equal(settledDays([settled("2026-08-10")], opts()).has("2026-08-10"), true);
});

test("a day missing a probe metric is not settled", () => {
  const partial: StoredDay = { ...settled("2026-08-10"), metricCount: 2 };
  assert.equal(settledDays([partial], opts()).has("2026-08-10"), false);
});

test("provisional days are queued for repair; settled ones are left alone", () => {
  const stored = [settled("2026-08-18"), provisional("2026-08-17"), settled("2026-08-16")];
  const dates = datesToCollect(stored, opts());
  assert.deepEqual(dates.slice(0, 2), ["2026-08-20", "2026-08-19"], "today and yesterday always");
  assert.ok(dates.includes("2026-08-17"), "the provisional day is repaired");
  assert.ok(!dates.includes("2026-08-18"), "a settled day is not re-fetched");
  assert.ok(!dates.includes("2026-08-16"), "nor is this one");
});

test("absent days are repaired too, and the window edge is reachable", () => {
  const dates = datesToCollect([], opts({ limit: 20 }));
  assert.ok(dates.includes("2026-08-06"), "the oldest day in a 14-day window");
  assert.ok(!dates.includes("2026-08-05"), "but nothing beyond it");
});

test("repair is bounded so a long outage cannot flood one run", () => {
  const dates = datesToCollect([], opts({ limit: 3 }));
  assert.equal(dates.length, 5, "today, yesterday, and three repairs");
});

test("today and yesterday are fetched even when they look settled", () => {
  // Yesterday is exactly when a provisional day becomes final, so it must be
  // re-fetched regardless of what is already stored for it.
  const dates = datesToCollect([settled("2026-08-19"), settled(TODAY)], opts());
  assert.ok(dates.includes(TODAY));
  assert.ok(dates.includes("2026-08-19"));
});

test("a run that found no pets is not a success", () => {
  // The per-pet loop simply does not execute, so nothing throws and every
  // error path stays quiet while no data at all is written.
  assert.equal(runOutcome({ petsFound: 0, petsKnownPreviously: 1, petsFailed: 0 }).ok, false);
  assert.match(
    runOutcome({ petsFound: 0, petsKnownPreviously: 1, petsFailed: 0 }).reason!,
    /were being tracked/
  );
  // A brand-new install is also not a success, but reads differently.
  const fresh = runOutcome({ petsFound: 0, petsKnownPreviously: 0, petsFailed: 0 });
  assert.equal(fresh.ok, false);
  assert.match(fresh.reason!, /nothing to collect/);
});

test("a partly failed run is not a success either", () => {
  assert.equal(runOutcome({ petsFound: 2, petsKnownPreviously: 2, petsFailed: 1 }).ok, false);
  assert.equal(runOutcome({ petsFound: 2, petsKnownPreviously: 2, petsFailed: 0 }).ok, true);
});

test("day-end uses the pet's timezone, including DST", () => {
  // A 23-hour day still ends when it ends; a write at 23:30 local on the
  // spring-forward day must not be judged against a 24-hour assumption.
  const springForward = "2026-03-08";
  const end = midnightEpoch(addDays(springForward, 1), TZ);
  const lateWrite: StoredDay = { date: springForward, metricCount: 3, lastWriteEpoch: end - 1800 };
  assert.equal(settledDays([lateWrite], opts()).has(springForward), false, "written before the day ended");
  const afterWrite: StoredDay = { ...lateWrite, lastWriteEpoch: end + 60 };
  assert.equal(settledDays([afterWrite], opts()).has(springForward), true);
});
