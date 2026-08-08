/**
 * Which readings are eligible to raise an alert.
 *
 * Day-selection for collection lives in collector.ts, which supersedes the
 * simpler "which days are absent" rule this module used to carry. One
 * implementation, not two: duplicated window arithmetic is how an off-by-one
 * survived undetected in the predecessor.
 *
 * Extracted from the collector so it can be tested directly. When this lived
 * inline in the route, a test could only re-implement the same filters beside
 * it — which passes whether or not the production code still does it.
 */

import { type DayPoint, recentWithinBand } from "./baseline";
import { WEAR_SENSITIVE, type Direction } from "./metrics";

/**
 * Metrics whose value for *today* is a partial running total rather than a
 * finished measurement. `activityDistribution.current` accrues through the day,
 * so an early run sees 20 minutes of a day that ends at 100.
 *
 * Averages (heart rate, respiratory rate) are NOT here: the vendor reports a
 * mean of the readings it took, which is meaningful at any hour. Excluding them
 * would delay a legitimate alert by a full day for no benefit.
 */
export const ACCRUING = new Set([
  "active_minutes",
  "rest_minutes",
  "calories",
  "distance",
  "scratching",
  "night_sleep_minutes",
  "day_sleep_minutes",
  "calm_minutes",
  "wear_time",
]);

export interface AlertSeriesOptions {
  /** Pet-local today. */
  today: string;
  /** Dates the collar was worn too little for totals to mean anything. */
  lowWear: ReadonlySet<string>;
}

/**
 * Filter a metric's history down to the readings that may legitimately drive an
 * alert: finished days, on which the device was actually being worn.
 */
export function alertSeries(
  series: DayPoint[],
  metric: string,
  { today, lowWear }: AlertSeriesOptions
): DayPoint[] {
  let out = series;
  // A day the collar was off is a day whose totals are unknown, not low.
  if (WEAR_SENSITIVE.has(metric)) out = out.filter((p) => !lowWear.has(p.date));
  // Today's total is still climbing for accruing metrics.
  if (ACCRUING.has(metric)) out = out.filter((p) => p.date < today);
  return out;
}

/**
 * Whether a detected deviation is recent enough to act on.
 *
 * detectDeviation anchors to the newest reading it was given, which may be
 * weeks old after an outage. `maxAgeDays` is deliberately tight: alerts are
 * keyed by the deviation's own date, so a stale condition cannot be re-raised
 * daily, but acting on week-old data would still be misleading.
 */
export function isCurrent(anchorDate: string | undefined, today: string, maxAgeDays = 2): boolean {
  if (!anchorDate) return false;
  const days = Math.round(
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${anchorDate}T00:00:00Z`)) / 86_400_000
  );
  return days >= 0 && days <= maxAgeDays;
}

/**
 * Whether a standing alert for this metric should be withdrawn.
 *
 * Requires positive evidence that the metric is normal — not merely the absence
 * of a finding. `detectDeviation` returns null for two very different reasons:
 * the readings are within the usual range, or there is not enough history to
 * have an opinion at all. Treating both as recovery meant that after a
 * collection gap a single fresh — and still abnormal — reading withdrew a real
 * alert, because 21 baseline days no longer fitted inside the window.
 */
export function shouldWithdraw(
  series: DayPoint[],
  deviationFound: boolean,
  today: string,
  direction: Direction
): boolean {
  if (deviationFound) return false;
  if (!isCurrent(series[series.length - 1]?.date, today)) return false; // stale: we learned nothing
  // Not merely "enough history existed" — the current readings must actually be
  // inside the usual range. Counting baseline rows was not evidence of recovery:
  // after filtered or missing days, one fresh but still-abnormal reading fails
  // the 2-of-3 rule, so no deviation is reported, and the alert was cleared
  // while the metric was still bad.
  return recentWithinBand(series, direction);
}

/** The fields that decide whether an alert belongs on the dashboard. */
export interface AlertVisibility {
  date: string;
  emailed: boolean;
  acknowledged: boolean;
  resolved: boolean;
}

/** Days an alert stays on the dashboard after the day it refers to. */
export const ALERT_DISPLAY_DAYS = 14;

/**
 * Whether an alert should appear on the dashboard.
 *
 * Decided here rather than in SQL so it can be tested — the equivalent WHERE
 * clause was the one rule in the alert lifecycle that no test could reach, and
 * every previous hole in that lifecycle was of the same kind: a state that was
 * simultaneously invisible and unfixable.
 *
 * The rules, and why each exists:
 *  - resolved: the condition has cleared but delivery is still outstanding. The
 *    row must survive for the retry, but presenting it as a live warning would
 *    claim a metric is trending after it recovered.
 *  - recent: ordinary display window.
 *  - undelivered and not dismissed: shown at any age, so nothing can be both
 *    impossible to deliver and impossible to see.
 *  - dismissed: the user has spoken; it does not come back via that clause.
 */
export function isAlertVisible(a: AlertVisibility): boolean {
  // Only two things end a warning: evidence the metric recovered, or the owner
  // saying they have seen it. NOT the calendar.
  //
  // Ageing off after a fixed window looked reasonable and was the project's
  // own worst failure: an episode keeps the date it started, so a condition
  // still being detected and still unresolved vanished from the dashboard
  // fourteen days later and the page went green underneath it. "Silence is
  // never good news" is the rule this app is built on, and a display window
  // quietly broke it.
  //
  // An old undelivered alert therefore also stays visible, which was already
  // the intent: nothing may be both impossible to deliver and impossible to
  // see. The withdrawal pass is what ends an episode, on evidence.
  if (a.resolved) return false;
  return !a.acknowledged;
}
