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

/** Milliseconds to add to a UTC instant to get wall-clock time in `tz`. */
function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const f: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") f[p.type] = Number(p.value);
  return Date.UTC(f.year, f.month - 1, f.day, f.hour % 24, f.minute, f.second) - utcMs;
}

/**
 * Unix seconds at local midnight opening `date` in `tz`. Resolves the offset
 * actually in force on that date, so it stays correct across DST transitions.
 */
export function midnightEpoch(date: string, tz: string): number {
  const naive = Date.parse(`${date}T00:00:00Z`);
  const first = naive - tzOffsetMs(naive, tz);
  return Math.floor((naive - tzOffsetMs(first, tz)) / 1000);
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
