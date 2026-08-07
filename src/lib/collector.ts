/**
 * Deciding which days a collection run should fetch.
 *
 * Pure, because this is where the subtlest failure in the predecessor lived and
 * it took a human noticing a chart to find it. Every rule here corresponds to a
 * day of data that was silently wrong.
 */

import { addDays, daysBetween } from "./time";

/** What the database knows about one already-stored day. */
export interface StoredDay {
  date: string;
  /** How many of the probe metrics are present for that date. */
  metricCount: number;
  /** Unix seconds of the newest write to that date. */
  lastWriteEpoch: number;
}

export interface PlanOptions {
  /** Pet-local today. */
  today: string;
  /** How far back to look for days needing repair. */
  window: number;
  /** Most days to repair in one run, so recovery stays gentle. */
  limit: number;
  /** How many probe metrics a complete day should have. */
  probeCount: number;
  /** Unix seconds at which a given local date ends. */
  dayEndEpoch: (date: string) => number;
}

/**
 * Days that are finished and fully recorded, and so need no further work.
 *
 * Two conditions, and the second is the one that was missing:
 *
 *  - every probe metric is present, and
 *  - the newest write happened AFTER the day ended.
 *
 * A collector running shortly after midnight captures the new day while every
 * elapsed-time total is still legitimately zero, and depends on a later run to
 * overwrite it once the day is done. If that later run fails, the day is left
 * reading zero activity, zero sleep, zero calories — and because rows exist for
 * it, a presence check calls it complete and never repairs it. Presence is not
 * completeness; a day written before it ended is provisional by definition.
 */
export function settledDays(stored: StoredDay[], opts: PlanOptions): Set<string> {
  const settled = new Set<string>();
  for (const d of stored) {
    if (d.metricCount < opts.probeCount) continue;
    if (d.lastWriteEpoch < opts.dayEndEpoch(d.date)) continue;
    settled.add(d.date);
  }
  return settled;
}

/**
 * The dates this run should fetch, newest first.
 *
 * Today and yesterday are always included: today because it is the live day,
 * yesterday because that is when it becomes final and its provisional figures
 * must be replaced. Everything else is repair work, bounded by `limit`.
 */
export function datesToCollect(stored: StoredDay[], opts: PlanOptions): string[] {
  const settled = settledDays(stored, opts);
  const dates = [opts.today, addDays(opts.today, -1)];

  for (let i = 2; i <= opts.window && dates.length < 2 + opts.limit; i++) {
    const date = addDays(opts.today, -i);
    if (!settled.has(date)) dates.push(date);
  }
  return dates;
}

/**
 * Whether a run that completed should be called a success.
 *
 * "Nothing threw" is not success. A source returning no pets writes no data at
 * all while every error path stays quiet, so the run reports fine and the
 * dashboard goes on showing last month. If pets were known before and none come
 * back now, they were removed or the account changed — neither is health.
 */
export function runOutcome(input: {
  petsFound: number;
  petsKnownPreviously: number;
  petsFailed: number;
}): { ok: boolean; reason?: string } {
  if (input.petsFound === 0) {
    return {
      ok: false,
      reason:
        input.petsKnownPreviously > 0
          ? `No pets were returned, but ${input.petsKnownPreviously} were being tracked. Nothing was collected.`
          : "No pets found on this source, so there is nothing to collect.",
    };
  }
  if (input.petsFailed > 0) {
    return { ok: false, reason: `${input.petsFailed} of ${input.petsFound} pets failed.` };
  }
  return { ok: true };
}

/** Days between two dates, for readability at call sites. */
export const daysApart = daysBetween;
