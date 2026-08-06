/**
 * Calendar and timezone helpers.
 *
 * Every day boundary in this app is a *pet-local* boundary resolved against a
 * real IANA timezone. Fixed UTC offsets are never acceptable: they are wrong for
 * half the year in any DST zone, and DST days are 23 or 25 hours long, not 24.
 */

const DAY_MS = 86_400_000;

/** Integer calendar-day index for a YYYY-MM-DD string. */
export function dayNum(date: string): number {
  return Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

/** YYYY-MM-DD `offset` days from `date`. */
export function addDays(date: string, offset: number): string {
  return new Date((dayNum(date) + offset) * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days between two YYYY-MM-DD strings (b - a). */
export function daysBetween(a: string, b: string): number {
  return dayNum(b) - dayNum(a);
}

/** Today's date (YYYY-MM-DD) in `tz`. */
export function localDate(tz: string, at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}


/**
 * Unix seconds at the first instant of local date `date` in `tz`.
 *
 * Binary search rather than offset arithmetic. Resolving the offset and
 * subtracting it assumes local midnight exists — but some zones move their
 * clocks AT midnight, so 00:00 never happens. America/Santiago's 2026-09-06
 * jumps 00:00 to 01:00; the two-pass version oscillated and returned 23:00 on
 * September 5, reporting a 24-hour day that is really 23. A day query then
 * pulled in an hour of the previous date and overstated wear.
 *
 * localDate() is monotonic in time, so the first instant whose local date is
 * not before the target is exactly the start of that date — 00:00 normally,
 * and the transition instant when midnight is skipped.
 */
export function midnightEpoch(date: string, tz: string): number {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const naive = Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);
  // No real zone is more than 26h from UTC; 36h is a safe bracket.
  let lo = naive - 36 * 3600;
  let hi = naive + 36 * 3600;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fmt.format(new Date(mid * 1000)) < date) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** [start, end) unix seconds covering the whole pet-local day `date`. */
export function dayRangeEpoch(date: string, tz: string): [number, number] {
  return [midnightEpoch(date, tz), midnightEpoch(addDays(date, 1), tz)];
}

/** True if `tz` is a timezone this runtime recognises. */
export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The most recent day that is definitely *finished* in `tz`. A globally-fixed
 * UTC cron must collect this, not "today": for users east of UTC, "today" at
 * cron time is a partial day that would be stored as if it were complete.
 */
export function lastCompleteDate(tz: string, at: Date = new Date()): string {
  return addDays(localDate(tz, at), -1);
}
