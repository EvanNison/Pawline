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
  /** Kept so spreadOf() can fall back when sMAD is zero. */
  values?: number[];
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
  return { median: med, smad, count: values.length, values };
}

/**
 * Robust scale estimate for the baseline.
 *
 * Scaled MAD is the first choice, but it is zero whenever at least half the
 * readings sit exactly on the median — routine for a tracker that reports whole
 * numbers. The old fallback of "10% of the median" then produced a band of
 * plus/minus 30%: a resting heart rate whose history is a flat 60 accepted
 * anything from 42 to 78, so a sustained rise to 75 raised nothing at all. A
 * missed alert is the one failure this whole app exists to prevent.
 *
 * So: fall back to the *mean* absolute deviation, which is non-zero whenever
 * any reading differs at all, scaled to be comparable to a standard deviation
 * (E|X-mu| = sigma*sqrt(2/pi) for a normal, hence the 1.2533). Only a genuinely
 * constant history reaches the final floor, and that floor is small — if a
 * value has not moved in sixty days, any movement is worth noticing.
 */
const MEAN_AD_TO_SIGMA = 1.2533;
/**
 * Last-resort spread for a perfectly constant history, as a fraction of it.
 *
 * A flat history means the reporting resolution exceeds the day-to-day
 * biological variation, so the data cannot tell us the spread and we must
 * assume one. 4% stands in for a plausible day-to-day sigma — about 2.5 bpm on
 * a 62 bpm resting heart rate — which puts the three-sigma band at roughly
 * plus/minus 12%. That tolerates rounding wobble while still catching the
 * sustained 25% rise the old 10% floor let through.
 */
const CONSTANT_HISTORY_FLOOR = 0.04;

export function spreadOf(base: Baseline, values?: number[]): number {
  if (base.smad > 0) return base.smad;
  if (values && values.length > 0) {
    const meanAD = values.reduce((s, v) => s + Math.abs(v - base.median), 0) / values.length;
    if (meanAD > 0) return MEAN_AD_TO_SIGMA * meanAD;
  }
  return Math.abs(base.median) * CONSTANT_HISTORY_FLOOR || 1;
}

export interface Band {
  low: number;
  high: number;
}

export function band(base: Baseline): Band {
  const s = spreadOf(base, base.values);
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

/**
 * Split a series into the detection window and the baseline history behind it,
 * both measured in calendar days from the newest reading.
 *
 * Single source of truth: detectDeviation, recentWithinBand and
 * hasSufficientHistory all ask the same question about the same windows, and
 * three hand-rolled copies of this arithmetic would drift — the off-by-one that
 * once made the baseline 59 days instead of 60 lived in exactly this code.
 */
export interface Windows {
  /** Readings inside the detection window (the most recent DETECTION_WINDOW days). */
  recent: DayPoint[];
  /** Values in the BASELINE_WINDOW days before it. */
  history: number[];
}

export function splitWindows(series: DayPoint[]): Windows | null {
  if (series.length === 0) return null;
  const anchor = dayNum(series[series.length - 1].date);
  const detectionStart = anchor - DETECTION_WINDOW + 1;
  // Inclusive lower bound: `>` here made the baseline 59 days wide, not the
  // documented 60, and disagreed with rollingBaseline.
  const historyStart = detectionStart - BASELINE_WINDOW;

  const recent: DayPoint[] = [];
  const history: number[] = [];
  for (const p of series) {
    const d = dayNum(p.date);
    if (d >= detectionStart) recent.push(p);
    else if (d >= historyStart) history.push(p.value);
  }
  return { recent, history };
}

/**
 * Whether a series carries enough history, in the right window, for
 * detectDeviation to reach any conclusion.
 *
 * Counting raw rows is not equivalent: 21 readings scattered over two years, or
 * 21 readings that all sit inside the excluded detection window, look like
 * enough and are not. Used to tell "no deviations" apart from "nothing has been
 * assessed", which must not be shown as the same green tick.
 */
export function hasSufficientHistory(series: DayPoint[]): boolean {
  const w = splitWindows(series);
  return w !== null && w.history.length >= MIN_BASELINE_DAYS;
}

/**
 * True when every reading in the detection window sits inside the usual range
 * on the metric's bad side — i.e. positive evidence that things are normal.
 *
 * This is NOT the negation of detectDeviation. That returns null both for
 * "readings are fine" and for "I cannot tell": too little history, or too few
 * recent readings to satisfy the 2-of-3 rule. After filtered or missing days, a
 * single fresh and still-abnormal reading produces exactly that ambiguous null —
 * so withdrawing a standing alert on it would clear a warning while the metric
 * is still bad. Withdrawal must require this instead.
 */
export function recentWithinBand(series: DayPoint[], direction: Direction): boolean {
  const w = splitWindows(series);
  if (!w) return false;
  if (w.history.length < MIN_BASELINE_DAYS) return false; // no basis for an opinion
  if (w.recent.length === 0) return false; // nothing current to judge

  const base = computeBaseline(w.history);
  if (!base) return false;
  const spread = spreadOf(base, w.history);
  const hi = base.median + SIGMA * spread;
  const lo = base.median - SIGMA * spread;

  const checkHigh = direction === "high_bad" || direction === "both";
  const checkLow = direction === "low_bad" || direction === "both";
  for (const p of w.recent) {
    if (checkHigh && p.value > hi) return false;
    if (checkLow && p.value < lo) return false;
  }
  return true;
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
  const w = splitWindows(series);
  if (!w) return null;
  const { recent, history } = w;
  if (history.length < MIN_BASELINE_DAYS) return null;

  const base = computeBaseline(history);
  if (!base) return null;
  const spread = spreadOf(base, history);
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
