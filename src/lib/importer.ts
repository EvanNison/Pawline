/**
 * Resumable history import.
 *
 * Pulling years of history is thousands of requests. It cannot run in one
 * serverless invocation (Vercel Hobby caps a function at 300s), and it cannot
 * depend on a browser tab staying open. So the import is a state machine whose
 * progress lives in the database: each invocation claims a bounded chunk of
 * days, records what it found, and returns. Anything can crash at any point and
 * the next invocation picks up exactly where it stopped.
 *
 * The walk goes *backwards* from the most recent day, so the first chunk gives
 * the user recent data to look at while the rest fills in behind it.
 *
 * This module is deliberately pure: it plans work and folds results, and never
 * touches the network or the database. That makes the awkward parts — the stop
 * conditions, the resume behaviour, the empty-day streak — testable.
 */

import { addDays, daysBetween } from "./time";

export type ImportState = "pending" | "running" | "done" | "failed" | "cancelled";

export interface ImportJob {
  petId: string;
  sourceId: string;
  state: ImportState;
  /** Next date to fetch, walking backwards. Null before the job starts. */
  cursorDate: string | null;
  /** Oldest date found to contain data. */
  earliestDate: string | null;
  /** Newest date found to contain data. */
  latestDate: string | null;
  daysDone: number;
  /** Consecutive empty days seen so far — the "we've reached the start" signal. */
  emptyStreak: number;
  lastError: string | null;
  /**
   * Why the job stopped, captured at the moment it finished.
   *
   * "Walked back to the start of this pet's history" and "hit the 1200-day
   * ceiling" both look like a completed import, but the second one means the
   * user is missing data and may want to raise the limit. A cap that is not
   * reported reads as full coverage, so the reason is stored rather than
   * recomputed — by then the job is `done` and the cause is unrecoverable.
   */
  finishedReason: string | null;
}

export interface ImportOptions {
  /** Days fetched per invocation. Keep the worst case well inside the timeout. */
  chunkSize: number;
  /**
   * Consecutive empty days that mean "before the tracker existed". Generous:
   * a fortnight's holiday with the collar off must not be mistaken for the end
   * of history. Vendors also zero-pad rather than 404 before setup.
   */
  emptyStreakLimit: number;
  /** Absolute floor on how far back to walk. */
  maxDays: number;
  /** Never walk earlier than this (e.g. the pet's date of birth). */
  floorDate?: string;
}

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  chunkSize: 20,
  emptyStreakLimit: 21,
  maxDays: 1200,
};

export function startJob(petId: string, sourceId: string, from: string): ImportJob {
  return {
    petId,
    sourceId,
    state: "pending",
    cursorDate: from,
    earliestDate: null,
    latestDate: null,
    daysDone: 0,
    emptyStreak: 0,
    lastError: null,
    finishedReason: null,
  };
}

/** True when the job stopped early rather than exhausting the pet's history. */
export function wasTruncated(job: ImportJob): boolean {
  return job.state === "done" && /limit|earliest allowed/.test(job.finishedReason ?? "");
}

export interface ChunkPlan {
  /** Dates to fetch, newest first. Empty when the job is finished. */
  dates: string[];
  finished: boolean;
  /** Why the job finished — surfaced to the user, so it must be plain English. */
  reason?: string;
}

/** Decide the next bounded batch of days, or that the job is complete. */
export function planChunk(job: ImportJob, opts: ImportOptions = DEFAULT_IMPORT_OPTIONS): ChunkPlan {
  if (job.state === "done") {
    return { dates: [], finished: true, reason: job.finishedReason ?? "already finished" };
  }
  if (job.state === "cancelled") return { dates: [], finished: true, reason: "cancelled" };
  if (!job.cursorDate) return { dates: [], finished: true, reason: "no start date" };

  if (job.emptyStreak >= opts.emptyStreakLimit) {
    return { dates: [], finished: true, reason: `reached the start of this pet's history` };
  }
  if (job.daysDone >= opts.maxDays) {
    return { dates: [], finished: true, reason: `stopped at the ${opts.maxDays}-day limit` };
  }

  const dates: string[] = [];
  let cursor = job.cursorDate;
  const budget = Math.min(opts.chunkSize, opts.maxDays - job.daysDone);
  for (let i = 0; i < budget; i++) {
    if (opts.floorDate && daysBetween(opts.floorDate, cursor) < 0) break;
    dates.push(cursor);
    cursor = addDays(cursor, -1);
  }

  if (dates.length === 0) {
    return { dates: [], finished: true, reason: "reached the earliest allowed date" };
  }
  return { dates, finished: false };
}

/** What one chunk actually found: which of the planned dates held data. */
export interface ChunkResult {
  /** Dates that returned at least one reading. */
  datesWithData: string[];
  /** Dates that were fetched successfully but held nothing. */
  emptyDates: string[];
  /** Set when the chunk failed partway; the job stays resumable. */
  error?: string;
}

/**
 * Fold a chunk's outcome into the job. Pure: same inputs, same output, so a
 * retried invocation cannot double-count.
 */
export function applyChunk(
  job: ImportJob,
  plan: ChunkPlan,
  result: ChunkResult,
  opts: ImportOptions = DEFAULT_IMPORT_OPTIONS
): ImportJob {
  const withData = new Set(result.datesWithData);
  const processed = [...result.datesWithData, ...result.emptyDates];

  // Recompute the empty streak by walking the planned dates newest-to-oldest,
  // rather than trusting a counter: a chunk that found data resets it, and a
  // chunk that failed partway must only count what it actually saw.
  let emptyStreak = job.emptyStreak;
  for (const date of plan.dates) {
    if (!processed.includes(date)) break; // not reached before the error
    if (withData.has(date)) emptyStreak = 0;
    else emptyStreak++;
  }

  const dated = [...withData].sort();
  const earliest = dated[0];
  const latest = dated[dated.length - 1];

  const oldestProcessed = processed.sort()[0];
  const next: ImportJob = {
    ...job,
    state: result.error ? "failed" : "running",
    cursorDate: oldestProcessed ? addDays(oldestProcessed, -1) : job.cursorDate,
    earliestDate:
      earliest && (!job.earliestDate || earliest < job.earliestDate) ? earliest : job.earliestDate,
    latestDate: latest && (!job.latestDate || latest > job.latestDate) ? latest : job.latestDate,
    daysDone: job.daysDone + processed.length,
    emptyStreak,
    lastError: result.error ?? null,
  };

  if (!result.error) {
    const after = planChunk(next, opts);
    if (after.finished) return { ...next, state: "done", finishedReason: after.reason ?? null };
  }
  return next;
}

export interface Progress {
  daysDone: number;
  /** 0-1, or null when the span is not yet known. */
  fraction: number | null;
  /** One line for a non-technical user. */
  summary: string;
}

export function progressOf(job: ImportJob, opts: ImportOptions = DEFAULT_IMPORT_OPTIONS): Progress {
  const fraction = job.state === "done" ? 1 : Math.min(job.daysDone / opts.maxDays, 0.99);
  const span =
    job.earliestDate && job.latestDate
      ? ` (${job.earliestDate} to ${job.latestDate})`
      : "";
  const summary =
    job.state === "done"
      ? wasTruncated(job)
        ? `Stopped early after ${job.daysDone} days${span} — ${job.finishedReason}. There may be older data still to import.`
        : `Finished — imported ${job.daysDone} days${span}.`
      : job.state === "failed"
        ? `Paused after ${job.daysDone} days: ${job.lastError ?? "unknown error"}. It will resume automatically.`
        : job.state === "cancelled"
          ? `Cancelled after ${job.daysDone} days.`
          : `Imported ${job.daysDone} days so far${span}…`;
  return { daysDone: job.daysDone, fraction: job.state === "done" ? 1 : fraction, summary };
}
