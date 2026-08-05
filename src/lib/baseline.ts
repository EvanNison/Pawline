/**
 * Baseline + deviation detection, using robust statistics.
 *
 *   baseline = median of the trailing BASELINE_WINDOW days, ending
 *              DETECTION_WINDOW days back so an emerging problem is not
 *              absorbed into "normal"
 *   spread   = scaled MAD (1.4826 x median absolute deviation), which unlike
 *              a standard deviation is not dragged around by the very outliers
 *              we are trying to detect
 *   alert    = at least MIN_DAYS_OUTSIDE of the last DETECTION_WINDOW *calendar
 *              days* sit beyond median +/- SIGMA*sMAD on the metric's bad side
 *
 * Every window here is measured in calendar days, never in "number of stored
 * readings". Collection gaps are routine, and counting readings would let three
 * points scattered over three weeks masquerade as three days running.
 */

import { dayNum } from "./time";
import type { Direction } from "./metrics";

export const MIN_BASELINE_DAYS = 21;
export const BASELINE_WINDOW = 60;
export const DETECTION_WINDOW = 3;
export const MIN_DAYS_OUTSIDE = 2;
const SIGMA = 3;
/** z at or above which a deviation is "alert" rather than "watch". */
const ALERT_Z = 4;

export interface DayPoint {
  date: string; // YYYY-MM-DD, ascending
  value: number;
}

export interface Baseline {
  median: number;
  smad: number;
  count: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function computeBaseline(values: number[]): Baseline | null {
  if (values.length < 2) return null;
  const med = median(values);
  const smad = 1.4826 * median(values.map((v) => Math.abs(v - med)));
  return { median: med, smad, count: values.length };
}

/**
 * A constant history gives sMAD 0, which would make every subsequent reading
 * infinitely deviant. Fall back to 10% of the median as the spread floor.
 */
function spreadOf(base: Baseline): number {
  return base.smad > 0 ? base.smad : Math.abs(base.median) * 0.1 || 1;
}

export interface Band {
  low: number;
  high: number;
}

export function band(base: Baseline): Band {
  const s = spreadOf(base);
  return { low: base.median - SIGMA * s, high: base.median + SIGMA * s };
}

/**
 * Per-day baseline for charting the "usual range" band.
 *
 * Holds to the same evidence bar as alerting (MIN_BASELINE_DAYS): a band drawn
 * from two readings looks authoritative and means nothing, which is worse than
 * drawing no band at all.
 */
export function rollingBaseline(series: DayPoint[]): (Baseline | null)[] {
  const days = series.map((p) => dayNum(p.date));
  return series.map((_, i) => {
    const end = days[i] - DETECTION_WINDOW; // newest day the baseline may use
    const start = end - BASELINE_WINDOW; // exclusive lower bound
    const values: number[] = [];
    for (let j = 0; j < i; j++) {
      if (days[j] > start && days[j] <= end) values.push(series[j].value);
    }
    if (values.length < MIN_BASELINE_DAYS) return null;
    return computeBaseline(values);
  });
}

export interface Deviation {
  metric: string;
  direction: "high" | "low";
  /** The most recent offending value. */
  value: number;
  date: string;
  baseline: Baseline;
  severity: "watch" | "alert";
  daysOutside: number;
}

/**
 * Detect a sustained deviation at the end of `series` (which must be ascending
 * by date). Returns null when there is not enough history to judge — silence
 * here means "no opinion", not "healthy".
 */
export function detectDeviation(
  series: DayPoint[],
  metric: string,
  direction: Direction
): Deviation | null {
  if (series.length === 0) return null;

  // Both windows are anchored to the newest reading's date and selected by
  // calendar day, so a gap in collection cannot manufacture a run of "days".
  const anchor = dayNum(series[series.length - 1].date);
  const detectionStart = anchor - DETECTION_WINDOW + 1;
  const historyStart = detectionStart - BASELINE_WINDOW;

  const recent: DayPoint[] = [];
  const history: number[] = [];
  for (const p of series) {
    const d = dayNum(p.date);
    if (d >= detectionStart) recent.push(p);
    // Inclusive: `>` made the baseline 59 days wide, not the documented
    // BASELINE_WINDOW of 60, and disagreed with rollingBaseline — so a chart
    // could draw a band while alerting still thought it lacked enough history.
    else if (d >= historyStart) history.push(p.value);
  }
  if (history.length < MIN_BASELINE_DAYS) return null;

  const base = computeBaseline(history);
  if (!base) return null;
  const spread = spreadOf(base);
  const { low, high } = band(base);

  const sides: ("high" | "low")[] =
    direction === "high_bad" ? ["high"] : direction === "low_bad" ? ["low"] : ["high", "low"];

  for (const side of sides) {
    const outside = recent.filter((p) => (side === "high" ? p.value > high : p.value < low));
    if (outside.length >= MIN_DAYS_OUTSIDE) {
      const worst = outside[outside.length - 1];
      const z = Math.abs(worst.value - base.median) / spread;
      return {
        metric,
        direction: side,
        value: worst.value,
        date: worst.date,
        baseline: base,
        severity: z >= ALERT_Z ? "alert" : "watch",
        daysOutside: outside.length,
      };
    }
  }
  return null;
}
