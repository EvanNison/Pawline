import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyChunk,
  planChunk,
  progressOf,
  startJob,
  type ChunkResult,
  type ImportJob,
  wasTruncated,
  type ImportOptions,
} from "../importer";

const OPTS: ImportOptions = { chunkSize: 5, emptyStreakLimit: 3, maxDays: 40 };

/** Drive a job to completion against a fake history, returning every day fetched. */
function runToCompletion(job: ImportJob, hasData: (d: string) => boolean, opts = OPTS) {
  const fetched: string[] = [];
  let current = job;
  for (let guard = 0; guard < 100; guard++) {
    const plan = planChunk(current, opts);
    if (plan.finished) return { job: current, fetched, reason: plan.reason };
    const datesWithData = plan.dates.filter(hasData);
    const emptyDates = plan.dates.filter((d) => !hasData(d));
    fetched.push(...plan.dates);
    current = applyChunk(current, plan, { datesWithData, emptyDates }, opts);
  }
  throw new Error("did not converge");
}

test("plans a bounded chunk walking backwards from the start date", () => {
  const plan = planChunk(startJob("p", "csv", "2026-08-10"), OPTS);
  assert.deepEqual(plan.dates, ["2026-08-10", "2026-08-09", "2026-08-08", "2026-08-07", "2026-08-06"]);
  assert.equal(plan.finished, false);
});

test("resumes exactly where the previous chunk stopped, with no gap or overlap", () => {
  const job = startJob("p", "csv", "2026-08-10");
  const plan = planChunk(job, OPTS);
  const after = applyChunk(job, plan, { datesWithData: plan.dates, emptyDates: [] }, OPTS);
  const next = planChunk(after, OPTS);
  assert.equal(next.dates[0], "2026-08-05", "continues from the day after the oldest processed");
  assert.equal(new Set([...plan.dates, ...next.dates]).size, plan.dates.length + next.dates.length);
});

test("stops after a run of empty days and reports why", () => {
  // Data exists only from 2026-08-06 onwards.
  const { fetched, job } = runToCompletion(startJob("p", "csv", "2026-08-10"), (d) => d >= "2026-08-06");
  assert.match(job.finishedReason!, /reached the start/);
  assert.equal(job.state, "done");
  assert.equal(job.earliestDate, "2026-08-06");
  assert.equal(job.latestDate, "2026-08-10");
  assert.ok(fetched.length < 20, `should stop early, fetched ${fetched.length}`);
});

test("a gap in the middle does not end the import", () => {
  // 10 days of data, a 2-day hole, then more. The hole is shorter than the
  // streak limit, so the walk must continue through it.
  const hasData = (d: string) => d >= "2026-07-20" && !(d === "2026-08-04" || d === "2026-08-05");
  const { job } = runToCompletion(startJob("p", "csv", "2026-08-10"), hasData, OPTS);
  assert.equal(job.earliestDate, "2026-07-20", "walked past the gap to the real start");
});

test("data found beyond an apparent end disproves it and the walk continues", () => {
  // A 4-day hole exceeds the 3-day streak limit, but the chunk keeps fetching
  // and finds data on the far side. That is proof the "we reached the start"
  // guess was wrong, and proof must beat the heuristic — stopping here would
  // silently discard three weeks of real history.
  const hasData = (d: string) => d >= "2026-07-20" && !(d >= "2026-08-04" && d <= "2026-08-07");
  const { job } = runToCompletion(startJob("p", "csv", "2026-08-10"), hasData, OPTS);
  assert.equal(job.earliestDate, "2026-07-20");
  assert.equal(job.latestDate, "2026-08-10");
});

test("the streak only ends the job when nothing further is found", () => {
  // Same shape, but genuinely nothing before the hole. Now the streak stands.
  const hasData = (d: string) => d >= "2026-08-08";
  const { job } = runToCompletion(startJob("p", "csv", "2026-08-10"), hasData, OPTS);
  assert.equal(job.state, "done");
  assert.equal(job.earliestDate, "2026-08-08");
  assert.match(job.finishedReason!, /reached the start/);
  assert.equal(wasTruncated(job), false, "reaching the true start is not truncation");
});

test("finding data resets the empty streak", () => {
  const job = startJob("p", "csv", "2026-08-10");
  const plan = planChunk(job, OPTS);
  const after = applyChunk(
    job,
    plan,
    { datesWithData: ["2026-08-06"], emptyDates: ["2026-08-10", "2026-08-09", "2026-08-08", "2026-08-07"] },
    OPTS
  );
  // Walking newest-first: 4 empties, then a hit — streak resets to 0.
  assert.equal(after.emptyStreak, 0);
  assert.equal(after.state, "running");
});

test("respects the maxDays ceiling", () => {
  const { job } = runToCompletion(startJob("p", "csv", "2026-08-10"), () => true, OPTS);
  assert.equal(job.daysDone, OPTS.maxDays);
  assert.match(job.finishedReason!, /40-day limit/);
  assert.equal(wasTruncated(job), true, "a cap must be reported, never silent");
  assert.match(progressOf(job, OPTS).summary, /Stopped early.*older data still to import/);
});

test("never walks earlier than floorDate", () => {
  const opts = { ...OPTS, floorDate: "2026-08-08" };
  const plan = planChunk(startJob("p", "csv", "2026-08-10"), opts);
  assert.deepEqual(plan.dates, ["2026-08-10", "2026-08-09", "2026-08-08"]);
  const after = applyChunk(startJob("p", "csv", "2026-08-10"), plan, { datesWithData: plan.dates, emptyDates: [] }, opts);
  assert.equal(planChunk(after, opts).finished, true);
});

test("a failed chunk stays resumable and only counts what it actually saw", () => {
  const job = startJob("p", "csv", "2026-08-10");
  const plan = planChunk(job, OPTS);
  // Crashed after the first two of five days.
  const result: ChunkResult = {
    datesWithData: ["2026-08-10"],
    emptyDates: ["2026-08-09"],
    error: "connection reset",
  };
  const after = applyChunk(job, plan, result, OPTS);
  assert.equal(after.state, "failed");
  assert.equal(after.daysDone, 2, "must not count the three days it never fetched");
  assert.equal(after.lastError, "connection reset");
  assert.equal(planChunk(after, OPTS).dates[0], "2026-08-08", "resumes at the first unfetched day");
});

test("replaying the same chunk twice does not double-count", () => {
  const job = startJob("p", "csv", "2026-08-10");
  const plan = planChunk(job, OPTS);
  const result = { datesWithData: plan.dates, emptyDates: [] };
  const once = applyChunk(job, plan, result, OPTS);
  const twice = applyChunk(job, plan, result, OPTS);
  assert.deepEqual(once, twice, "applyChunk must be pure");
});

test("a cancelled job stops immediately", () => {
  const job: ImportJob = { ...startJob("p", "csv", "2026-08-10"), state: "cancelled" };
  const plan = planChunk(job, OPTS);
  assert.equal(plan.finished, true);
  assert.equal(plan.dates.length, 0);
  assert.equal(plan.reason, "cancelled");
});

test("progress messages are plain English at every state", () => {
  const base = startJob("p", "csv", "2026-08-10");
  assert.match(progressOf(base, OPTS).summary, /Imported 0 days so far/);
  assert.match(
    progressOf({ ...base, state: "done", daysDone: 700, finishedReason: "reached the start of this pet's history" }, OPTS).summary,
    /Finished — imported 700 days/
  );
  assert.match(
    progressOf({ ...base, state: "failed", daysDone: 12, lastError: "login failed" }, OPTS).summary,
    /Paused after 12 days: login failed\. It will resume automatically\./
  );
  assert.match(progressOf({ ...base, state: "cancelled", daysDone: 5 }, OPTS).summary, /Cancelled after 5 days/);
});

test("progress fraction reaches 1 only when done, and never exceeds it", () => {
  const base = startJob("p", "csv", "2026-08-10");
  assert.equal(progressOf({ ...base, state: "done", daysDone: 700, finishedReason: "done" }, OPTS).fraction, 1);
  const mid = progressOf({ ...base, daysDone: 20 }, OPTS).fraction!;
  assert.ok(mid > 0 && mid < 1, `${mid}`);
  assert.ok(progressOf({ ...base, daysDone: 9999 }, OPTS).fraction! <= 1);
});

test("a full multi-year import converges and finds the true span", () => {
  const opts: ImportOptions = { chunkSize: 20, emptyStreakLimit: 21, maxDays: 1200 };
  // Two years of data ending 2026-08-10.
  const hasData = (d: string) => d >= "2024-08-29" && d <= "2026-08-10";
  const { job, fetched } = runToCompletion(startJob("p", "tractive", "2026-08-10"), hasData, opts);
  assert.equal(job.state, "done");
  assert.equal(job.earliestDate, "2024-08-29");
  assert.equal(job.latestDate, "2026-08-10");
  // Walks the real span plus one streak-limit of empties to confirm the start.
  assert.ok(fetched.length < 740 + 40, `fetched ${fetched.length}`);
});
