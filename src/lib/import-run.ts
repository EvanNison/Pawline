/**
 * Running a historical backfill, one chunk per collection.
 *
 * `importer.ts` holds the decision logic and is tested without a database. This
 * is the part that loads a job, asks it what to fetch, fetches it, and saves the
 * result — deliberately thin.
 *
 * Chunked because a vendor API cannot deliver two years inside one serverless
 * request: 700 days at several calls each is tens of minutes of sequential HTTP.
 * So each run walks a little further back and stores where it got to. A user who
 * connects a tracker sees their history fill in over a few days rather than not
 * at all, which is what happened before this existed — the collector repaired a
 * 14-day window and never looked further back, so a new install could never
 * recover the history the vendor was holding.
 */

import { sql } from "./db";
import {
  applyChunk,
  planChunk,
  progressOf,
  startJob,
  DEFAULT_IMPORT_OPTIONS,
  type ImportJob,
  type ImportOptions,
} from "./importer";
import { addCapability, writeReadingsBulk } from "./store";
import type { Source } from "./sources/types";

function rowToJob(r: Record<string, unknown>): ImportJob {
  return {
    petId: String(r.pet_id),
    sourceId: String(r.source_id),
    state: String(r.state) as ImportJob["state"],
    cursorDate: (r.cursor_date as string | null) ?? null,
    earliestDate: (r.earliest_date as string | null) ?? null,
    latestDate: (r.latest_date as string | null) ?? null,
    daysDone: Number(r.days_done ?? 0),
    daysWithData: Number(r.days_with_data ?? 0),
    emptyStreak: Number(r.empty_streak ?? 0),
    lastError: (r.last_error as string | null) ?? null,
    finishedReason: (r.finished_reason as string | null) ?? null,
  };
}

async function save(job: ImportJob): Promise<void> {
  await sql()`insert into import_jobs
      (pet_id, source_id, state, cursor_date, earliest_date, latest_date,
       days_done, days_with_data, empty_streak, last_error, finished_reason, updated_at)
    values (${job.petId}, ${job.sourceId}, ${job.state}, ${job.cursorDate},
            ${job.earliestDate}, ${job.latestDate}, ${job.daysDone},
            ${job.daysWithData}, ${job.emptyStreak}, ${job.lastError},
            ${job.finishedReason}, now())
    on conflict (pet_id, source_id) do update set
      state = excluded.state, cursor_date = excluded.cursor_date,
      earliest_date = excluded.earliest_date, latest_date = excluded.latest_date,
      days_done = excluded.days_done, days_with_data = excluded.days_with_data,
      empty_streak = excluded.empty_streak, last_error = excluded.last_error,
      finished_reason = excluded.finished_reason, updated_at = now()`;
}

/** The stored job for a pet and source, or null if none has been started. */
export async function readJob(petId: string, sourceId: string): Promise<ImportJob | null> {
  const [row] = await sql()`select * from import_jobs
    where pet_id = ${petId} and source_id = ${sourceId}`;
  return row ? rowToJob(row as Record<string, unknown>) : null;
}

/**
 * Begin walking backwards from `from`, or restart a finished job.
 *
 * Idempotent by (pet, source): starting twice replaces the job rather than
 * running two walks over the same history at once.
 */
export async function beginBackfill(petId: string, sourceId: string, from: string): Promise<ImportJob> {
  const job = startJob(petId, sourceId, from);
  await save(job);
  return job;
}

export interface ChunkOutcome {
  job: ImportJob;
  fetched: number;
  written: number;
  finished: boolean;
}

/**
 * Advance one chunk. Safe to call on every collection; returns immediately when
 * there is no job, or the job has finished.
 *
 * A fetch failure is recorded on the job and the cursor is left where it was, so
 * the next run retries the same dates rather than skipping them. Losing a day
 * silently is worse than taking another run to get it.
 */
export async function advanceBackfill(
  source: Source,
  petId: string,
  petKey: string,
  opts: ImportOptions = DEFAULT_IMPORT_OPTIONS
): Promise<ChunkOutcome | null> {
  const existing = await readJob(petId, source.info.id);
  if (!existing) return null;
  if (existing.state === "done" || existing.state === "cancelled") return null;

  const plan = planChunk(existing, opts);
  if (plan.finished) {
    const done: ImportJob = { ...existing, state: "done", finishedReason: plan.reason ?? null };
    await save(done);
    return { job: done, fetched: 0, written: 0, finished: true };
  }

  const datesWithData: string[] = [];
  const emptyDates: string[] = [];
  let written = 0;

  try {
    for (const date of plan.dates) {
      const readings = await source.fetchDay(petKey, date);
      if (readings.length > 0) {
        written += await writeReadingsBulk(petId, source.info.id, readings);
        for (const r of readings) await addCapability(petId, r.metric);
        datesWithData.push(date);
      } else {
        emptyDates.push(date);
      }
    }
  } catch (e) {
    // Whatever was fetched before the failure is already stored and is applied
    // below, so the work is not thrown away; the cursor simply stops at the
    // first date this run could not account for.
    const failed: ImportJob = {
      ...applyChunk({ ...existing, state: "running" }, plan, { datesWithData, emptyDates }, opts),
      state: "running",
      lastError: String(e).slice(0, 300),
    };
    await save(failed);
    return { job: failed, fetched: datesWithData.length + emptyDates.length, written, finished: false };
  }

  const next = applyChunk({ ...existing, state: "running", lastError: null }, plan, { datesWithData, emptyDates }, opts);
  await save(next);
  return {
    job: next,
    fetched: plan.dates.length,
    written,
    finished: next.state === "done",
  };
}

/** Human-readable progress for the status and setup pages. */
export async function backfillProgress(petId: string, sourceId: string, opts: ImportOptions = DEFAULT_IMPORT_OPTIONS) {
  const job = await readJob(petId, sourceId);
  if (!job) return null;
  return { job, progress: progressOf(job, opts) };
}
