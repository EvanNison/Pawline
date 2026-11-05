/**
 * Composite indicators: several readings judged together.
 *
 * These sit ON TOP of the single-metric alerts in baseline.ts / alerting.ts and
 * never replace or suppress any of them. A single metric drifting is already
 * reported on its own. What a composite adds is the thing a list of separate
 * warnings cannot say: "these are happening AT THE SAME TIME", which is the
 * pattern worth taking more seriously (the Apple Vitals / Oura idea).
 *
 * Everything is judged against the dog's own baseline, using exactly the same
 * windows as alerting: the 60 days ending three days before the day in
 * question. Inputs are expected to be pre-filtered with alertSeries(), so
 * low-wear days and still-accruing totals never count.
 *
 * Not a diagnosis. These are tools for noticing change and talking to a vet.
 */

import { dayNum } from "./time";
import {
  type DayPoint,
  computeBaseline,
  spreadOf,
  MIN_BASELINE_DAYS,
  BASELINE_WINDOW,
  DETECTION_WINDOW,
} from "./baseline";

export type BadSide = "high" | "low" | "both";

export interface SignalDef {
  metric: string;
  label: string;
  bad: BadSide;
}

/**
 * The vitals the "Vitals check" looks across.
 *
 * Judged on the worrying side only: heart and breathing UP, wake-ups UP,
 * activity DOWN. Unusually low heart or breathing rates are still reported by
 * the single-metric alerts; they are not the "fighting something off" pattern
 * this check exists to spot.
 *
 * Night-sleep minutes are deliberately absent. Tractive's figure has a heavy
 * tail of implausibly short nights, and in a backtest over ~18 months of one
 * dog's data it pushed the check to flag one day in six, almost all noise. A layer
 * meant to say "take this one more seriously" is useless if it says it weekly.
 */
export const VITAL_SIGNALS: SignalDef[] = [
  { metric: "resting_heart_rate", label: "Resting heart rate", bad: "high" },
  { metric: "resting_respiratory_rate", label: "Breathing rate", bad: "high" },
  { metric: "sleep_interruptions", label: "Night wake-ups", bad: "high" },
  { metric: "active_minutes", label: "Activity", bad: "low" },
];

/** Itch & comfort: scratching plus restless nights. */
export const COMFORT_SIGNALS: SignalDef[] = [
  { metric: "scratching", label: "Scratching", bad: "high" },
  { metric: "sleep_interruptions", label: "Night wake-ups", bad: "high" },
];

/**
 * How far from usual a reading must be to count as "off" in a composite.
 *
 * Looser than the 3-spread single-metric alert, because the composite's
 * evidence is agreement between metrics rather than how extreme any one is.
 * 2.5 was chosen by backtest on ~18 months of one dog's data: it flags about
 * 4% of days, and they fall in a few distinct multi-day episodes (such as time
 * away from home) rather than scattered single days. At 2.0 it flagged 7% and
 * picked up isolated noise.
 */
export const OFF_Z = 2.5;

export type SeriesMap = ReadonlyMap<string, DayPoint[]>;

export interface Reading {
  metric: string;
  label: string;
  value: number;
  median: number;
  /** Signed distance from usual, in spreads. */
  z: number;
  /** Distance on the metric's bad side only (0 when on the good side). */
  badZ: number;
  side: "high" | "low";
}

/**
 * One metric's reading on `date`, compared with its personal baseline.
 * Null when there is no reading that day or not enough history behind it.
 */
export function readingOn(series: DayPoint[] | undefined, def: SignalDef, date: string): Reading | null {
  if (!series || series.length === 0) return null;
  const d = dayNum(date);
  const point = series.find((p) => p.date === date);
  if (!point) return null;
  // Same windows as splitWindows(): detection window is [d-2, d], baseline is
  // the BASELINE_WINDOW days before it.
  const detectionStart = d - DETECTION_WINDOW + 1;
  const historyStart = detectionStart - BASELINE_WINDOW;
  const history: number[] = [];
  for (const p of series) {
    const n = dayNum(p.date);
    if (n >= historyStart && n < detectionStart) history.push(p.value);
  }
  if (history.length < MIN_BASELINE_DAYS) return null;
  const base = computeBaseline(history);
  if (!base) return null;
  const spread = spreadOf(base, history);
  const z = (point.value - base.median) / spread;
  const side = z >= 0 ? "high" : "low";
  const badZ =
    def.bad === "both" ? Math.abs(z) : def.bad === "high" ? Math.max(0, z) : Math.max(0, -z);
  return { metric: def.metric, label: def.label, value: point.value, median: base.median, z, badZ, side };
}

export type CompositeLevel = "unknown" | "normal" | "one" | "watch" | "alert";

export interface CompositeDay {
  date: string;
  /** How many signals could be judged that day. */
  checked: number;
  /** Signals outside their usual range on their bad side. */
  off: Reading[];
  level: CompositeLevel;
}

/**
 * Judge a set of signals together on one day.
 *
 *   alert  - 3+ off together, or heart rate AND breathing both up together
 *   watch  - 2 off together
 *   one    - a single signal off (the single-metric alerts already cover it)
 *   normal - everything within usual range
 *   unknown- fewer than 2 signals could be judged
 */
export function compositeOn(map: SeriesMap, signals: SignalDef[], date: string, offZ = OFF_Z): CompositeDay {
  const readings = signals
    .map((def) => readingOn(map.get(def.metric), def, date))
    .filter((r): r is Reading => r !== null);
  const off = readings.filter((r) => r.badZ >= offZ);
  let level: CompositeLevel;
  if (readings.length < 2) level = "unknown";
  else if (off.length === 0) level = "normal";
  else if (off.length === 1) level = "one";
  else {
    const up = (m: string) => off.some((r) => r.metric === m && r.side === "high");
    const heartAndBreath = up("resting_heart_rate") && up("resting_respiratory_rate");
    level = off.length >= 3 || heartAndBreath ? "alert" : "watch";
  }
  return { date, checked: readings.length, off, level };
}

export const vitalsOn = (map: SeriesMap, date: string) => compositeOn(map, VITAL_SIGNALS, date);
export const comfortOn = (map: SeriesMap, date: string) => compositeOn(map, COMFORT_SIGNALS, date);

/** How many of the most recent days, consecutively, were watch or alert. */
export function flaggedStreak(days: CompositeDay[]): number {
  let n = 0;
  for (let i = days.length - 1; i >= 0; i--) {
    const l = days[i].level;
    if (l === "watch" || l === "alert") n++;
    else if (l === "unknown") continue; // a missing day neither breaks nor extends it
    else break;
  }
  return n;
}

// ------------------------------------------------------------------ readiness

/** Weights for the readiness score; heart and breathing dominate. */
export const READINESS_WEIGHTS: Record<string, number> = {
  resting_heart_rate: 0.35,
  resting_respiratory_rate: 0.35,
  sleep_interruptions: 0.15,
  active_minutes: 0.15,
};

/** 100 within 1 spread of usual on the bad side, falling to 0 at 4 spreads. */
export function subScore(badZ: number): number {
  return Math.max(0, Math.min(100, 100 - Math.max(0, badZ - 1) * (100 / 3)));
}

export interface Readiness {
  date: string;
  score: number;
  band: "good" | "fair" | "low";
  parts: { label: string; score: number }[];
}

/**
 * A 0-100 "how normal does today look for him" score, Oura-Readiness style.
 * Null unless heart rate or breathing could be judged and at least half the
 * weight is present: a score from activity alone would be misleading.
 */
export function readinessOn(map: SeriesMap, date: string): Readiness | null {
  let total = 0;
  let weight = 0;
  let hasCore = false;
  const parts: { label: string; score: number }[] = [];
  for (const def of VITAL_SIGNALS) {
    const w = READINESS_WEIGHTS[def.metric] ?? 0;
    const r = readingOn(map.get(def.metric), def, date);
    if (!r || w === 0) continue;
    if (def.metric === "resting_heart_rate" || def.metric === "resting_respiratory_rate") hasCore = true;
    const sc = subScore(r.badZ);
    parts.push({ label: def.label, score: Math.round(sc) });
    total += sc * w;
    weight += w;
  }
  if (!hasCore || weight < 0.5) return null;
  const score = Math.round(total / weight);
  return { date, score, band: score >= 80 ? "good" : score >= 60 ? "fair" : "low", parts };
}

// ---------------------------------------------------------------- long term

export interface MonthPoint {
  month: string; // YYYY-MM
  median: number;
  days: number;
}

/** Monthly medians; months with fewer than `minDays` readings are dropped. */
export function monthlyMedians(series: DayPoint[] | undefined, minDays = 10): MonthPoint[] {
  const by = new Map<string, number[]>();
  for (const p of series ?? []) {
    const m = p.date.slice(0, 7);
    if (!by.has(m)) by.set(m, []);
    by.get(m)!.push(p.value);
  }
  return [...by.entries()]
    .filter(([, v]) => v.length >= minDays)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([month, v]) => ({ month, median: computeBaseline(v.length > 1 ? v : [v[0], v[0]])!.median, days: v.length }));
}

export interface LongTrend {
  /** Median of the 90 days before the most recent 3 weeks. */
  recent: number;
  /** Median of the same 90-day stretch one year earlier (or the earliest 90 days available). */
  earlier: number;
  earlierLabel: string;
  change: number;
  direction: "up" | "down" | "flat";
}

/**
 * Slow drift, the thing a 60-day baseline is built NOT to see (it moves with
 * the dog). Compares a recent 90-day median with a year earlier.
 *
 * The most recent 21 days are left out so a short-term episode - a stressful
 * week away - does not masquerade as a long-term change; that is what the
 * daily alerts and the Vitals check are for.
 */
export function longTrend(series: DayPoint[] | undefined, today: string, flatWithin?: number): LongTrend | null {
  if (!series || series.length === 0) return null;
  const t = dayNum(today);
  const window = (end: number) =>
    series.filter((p) => {
      const n = dayNum(p.date);
      return n > end - 90 && n <= end;
    }).map((p) => p.value);
  const recentVals = window(t - 21);
  if (recentVals.length < 30) return null;
  let earlierVals = window(t - 21 - 365);
  let earlierLabel = "a year earlier";
  if (earlierVals.length < 30) {
    const first = dayNum(series[0].date);
    if (t - 21 - 90 - first < 120) return null; // need at least ~4 months of separation
    earlierVals = window(first + 89);
    earlierLabel = `when tracking began (${series[0].date.slice(0, 7)})`;
    if (earlierVals.length < 30) return null;
  }
  const recent = computeBaseline(recentVals)!.median;
  const earlier = computeBaseline(earlierVals)!.median;
  const change = recent - earlier;
  // "Steady" within 3% (at least 0.5): 61 vs 62 bpm is noise, 12 -> 15 brpm is not.
  const tolerance = flatWithin ?? Math.max(0.5, Math.abs(earlier) * 0.03);
  return {
    recent,
    earlier,
    earlierLabel,
    change,
    direction: Math.abs(change) <= tolerance ? "flat" : change > 0 ? "up" : "down",
  };
}

// ------------------------------------------------------------------ context

export interface JournalEntry {
  date: string;
  end_date?: string | null;
  category: string;
  note: string;
}

/**
 * Journal entries that explain a day: ones covering it, or ones that ended in
 * the `afterDays` before it (a stay away can echo for a few days after).
 */
export function contextFor(entries: JournalEntry[], date: string, afterDays = 3): JournalEntry[] {
  const d = dayNum(date);
  return entries.filter((e) => {
    const start = dayNum(e.date);
    const end = dayNum(e.end_date || e.date);
    return d >= start && d <= end + afterDays;
  });
}

/** Plain-English one-liner for a flagged composite day, used in email and UI. */
export function describeComposite(day: CompositeDay, unitFor: (metric: string) => string): string {
  const parts = day.off.map((r) => {
    const dir = r.side === "high" ? "up" : "down";
    const u = unitFor(r.metric);
    return `${r.label.toLowerCase()} ${dir} (${fmt(r.value)}${u ? " " + u : ""} vs usual ${fmt(r.median)})`;
  });
  return `${day.off.length} vitals off together: ${parts.join(", ")}.`;
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** Range options (days) for the composite cards on the dashboard. */
export const SUMMARY_RANGES: [number, string][] = [
  [14, "2 wks"],
  [30, "1 mo"],
  [90, "3 mo"],
  [365, "1 yr"],
];
