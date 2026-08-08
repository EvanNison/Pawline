/**
 * Canonical metric registry.
 *
 * This replaces the regex-classifier approach from the original app. Regex
 * matching over flattened vendor payloads was convenient for *discovering* what
 * a tracker returns, but it is the wrong mechanism for anything a chart or a
 * vet report presents: a broad pattern can silently bind the wrong field to a
 * medical-looking line, and it cannot know what unit the field was in.
 *
 * So: adapters map explicitly into these keys, and discovery is a separate,
 * clearly-labelled activity that never auto-promotes a field into alerting.
 */

import type { Dimension } from "./units";

export type Species = "dog" | "cat" | "unknown";

/** Which way is "bad" — decides which tail of the baseline raises an alert. */
export type Direction = "high_bad" | "low_bad" | "both";

export interface MetricDef {
  key: string;
  label: string;
  dimension: Dimension;
  direction: Direction;
  /** Eligible for baseline deviation alerts. */
  alert: boolean;
  /** Species this metric is meaningful for. */
  species: Species[];
  /** Shown under the chart. Plain language — non-technical users read this. */
  help?: string;
  /**
   * The range the quantity can physically occupy, in canonical units.
   *
   * A baseline band is median +/- 3 spreads, which for a noisy metric runs past
   * what is possible: the predecessor drew a "usual range" for nightly wakeups
   * reaching -10, and one for a score out of 100 reaching 140. A range
   * containing impossible readings tells the reader the chart has not been
   * thought about.
   */
  min?: number;
  max?: number;
}

/** Minutes in a day. DST makes one day a year longer, hence 25h of wear. */
const DAY_MINUTES = 24 * 60;

export const REGISTRY: MetricDef[] = [
  {
    key: "resting_heart_rate",
    label: "Resting Heart Rate",
    dimension: "rate",
    direction: "both",
    alert: true,
    species: ["dog", "cat"],
    help: "Beats per minute while at rest. Sustained changes in either direction are worth a vet's attention.",
    min: 0,
  },
  {
    key: "resting_respiratory_rate",
    label: "Resting Respiratory Rate",
    dimension: "rate",
    direction: "both",
    alert: true,
    species: ["dog", "cat"],
    help: "Breaths per minute while at rest.",
    min: 0,
  },
  {
    key: "sleep_score",
    label: "Sleep Score",
    dimension: "score",
    direction: "low_bad",
    alert: true,
    species: ["dog", "cat"],
    min: 0,
    max: 100,
  },
  {
    key: "night_sleep_minutes",
    label: "Night Sleep",
    dimension: "duration",
    direction: "low_bad",
    alert: true,
    species: ["dog", "cat"],
    min: 0,
    max: DAY_MINUTES,
  },
  {
    key: "day_sleep_minutes",
    label: "Day Sleep",
    dimension: "duration",
    direction: "both",
    alert: false,
    species: ["dog", "cat"],
    min: 0,
    max: DAY_MINUTES,
  },
  {
    key: "calm_minutes",
    label: "Calm Rest",
    dimension: "duration",
    direction: "both",
    alert: false,
    species: ["dog", "cat"],
    min: 0,
    max: DAY_MINUTES,
  },
  {
    key: "sleep_interruptions",
    label: "Sleep Interruptions",
    dimension: "count",
    direction: "high_bad",
    alert: true,
    species: ["dog", "cat"],
    min: 0,
  },
  {
    key: "active_minutes",
    label: "Activity",
    dimension: "duration",
    direction: "low_bad",
    alert: true,
    species: ["dog", "cat"],
    min: 0,
    max: DAY_MINUTES,
  },
  {
    key: "rest_minutes",
    label: "Rest",
    dimension: "duration",
    direction: "both",
    alert: false,
    species: ["dog", "cat"],
    min: 0,
    max: DAY_MINUTES,
  },
  {
    key: "calories",
    label: "Calories Burned",
    dimension: "energy",
    direction: "both",
    alert: false,
    species: ["dog", "cat"],
    min: 0,
  },
  {
    key: "distance",
    label: "Distance Travelled",
    dimension: "distance",
    direction: "low_bad",
    alert: false,
    species: ["dog", "cat"],
    min: 0,
  },
  {
    key: "weight",
    label: "Weight",
    dimension: "mass",
    direction: "both",
    alert: true,
    species: ["dog", "cat"],
    help: "A trend vets routinely ask about, and one trackers rarely record. Log it manually if yours doesn't.",
    min: 0,
  },
  {
    key: "scratching",
    label: "Scratching / Itch",
    dimension: "duration",
    direction: "high_bad",
    alert: true,
    species: ["dog", "cat"],
    help: "Time spent scratching. A sustained rise is worth mentioning to your vet; what it means is theirs to say, not this app's.",
    min: 0,
    max: DAY_MINUTES,
  },
  {
    key: "barking_events",
    label: "Barking",
    dimension: "count",
    direction: "high_bad",
    alert: false,
    species: ["dog"],
    min: 0,
  },
  {
    key: "wear_time",
    label: "Collar Wear Time",
    dimension: "duration",
    direction: "low_bad",
    alert: false,
    species: ["dog", "cat"],
    help: "How long the tracker was worn. Low wear explains dips in every other metric — check this first.",
    min: 0,
    max: 25 * 60,
  },
];

/**
 * Daily totals that undercount when the collar is off: they measure elapsed
 * activity, so a half-worn day reports a genuinely small number for a day whose
 * true value is unknown. Averages (heart rate, respiratory rate) are excluded —
 * a partial day still yields a valid average from the readings it did take.
 */
export const WEAR_SENSITIVE = new Set([
  "active_minutes",
  "rest_minutes",
  "calories",
  "distance",
  "scratching",
  "night_sleep_minutes",
  "day_sleep_minutes",
  "calm_minutes",
  "sleep_interruptions",
  "sleep_score",
]);

/** Below this many minutes of wear, a day's totals are treated as unknown. */
export const MIN_WEAR_MINUTES = 18 * 60;

/** Clamp a value to the range its metric can physically occupy. */
export function clampToRange(key: string, value: number): number {
  const def = BY_KEY.get(key);
  if (!def) return value;
  let v = value;
  if (def.min !== undefined) v = Math.max(def.min, v);
  if (def.max !== undefined) v = Math.min(def.max, v);
  return v;
}

const BY_KEY = new Map(REGISTRY.map((m) => [m.key, m]));

export function metric(key: string): MetricDef | undefined {
  return BY_KEY.get(key);
}

/** Metrics meaningful for a species AND supported by that pet's hardware. */
export function availableMetrics(species: Species, capabilities: string[]): MetricDef[] {
  const cap = new Set(capabilities);
  // Species is compared case-insensitively, and an unrecognised value shows
  // everything rather than nothing. A vendor returning "DOG" against a registry
  // storing "dog" hid every chart on a real account while the readings sat in
  // the table — failing open is the right direction for a filter whose only job
  // is to hide charts that would be empty anyway.
  const sp = String(species ?? "").trim().toLowerCase();
  const known = sp === "dog" || sp === "cat";
  return REGISTRY.filter((m) => cap.has(m.key) && (!known || m.species.includes(sp as Species)));
}

/** True if `key` names a metric an adapter is allowed to emit. */
export function isKnownMetric(key: string): boolean {
  return BY_KEY.has(key);
}
