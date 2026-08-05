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
}

export const REGISTRY: MetricDef[] = [
  {
    key: "resting_heart_rate",
    label: "Resting Heart Rate",
    dimension: "rate",
    direction: "both",
    alert: true,
    species: ["dog", "cat"],
    help: "Beats per minute while at rest. Sustained changes in either direction are worth a vet's attention.",
  },
  {
    key: "resting_respiratory_rate",
    label: "Resting Respiratory Rate",
    dimension: "rate",
    direction: "both",
    alert: true,
    species: ["dog", "cat"],
    help: "Breaths per minute while at rest.",
  },
  {
    key: "sleep_score",
    label: "Sleep Score",
    dimension: "score",
    direction: "low_bad",
    alert: true,
    species: ["dog", "cat"],
  },
  {
    key: "night_sleep_minutes",
    label: "Night Sleep",
    dimension: "duration",
    direction: "low_bad",
    alert: true,
    species: ["dog", "cat"],
  },
  {
    key: "day_sleep_minutes",
    label: "Day Sleep",
    dimension: "duration",
    direction: "both",
    alert: false,
    species: ["dog", "cat"],
  },
  {
    key: "calm_minutes",
    label: "Calm Rest",
    dimension: "duration",
    direction: "both",
    alert: false,
    species: ["dog", "cat"],
  },
  {
    key: "sleep_interruptions",
    label: "Sleep Interruptions",
    dimension: "count",
    direction: "high_bad",
    alert: true,
    species: ["dog", "cat"],
  },
  {
    key: "active_minutes",
    label: "Activity",
    dimension: "duration",
    direction: "low_bad",
    alert: true,
    species: ["dog", "cat"],
  },
  {
    key: "rest_minutes",
    label: "Rest",
    dimension: "duration",
    direction: "both",
    alert: false,
    species: ["dog", "cat"],
  },
  {
    key: "calories",
    label: "Calories Burned",
    dimension: "energy",
    direction: "both",
    alert: false,
    species: ["dog", "cat"],
  },
  {
    key: "distance",
    label: "Distance Travelled",
    dimension: "distance",
    direction: "low_bad",
    alert: false,
    species: ["dog", "cat"],
  },
  {
    key: "weight",
    label: "Weight",
    dimension: "mass",
    direction: "both",
    alert: true,
    species: ["dog", "cat"],
    help: "The single most vet-relevant trend. Log it manually if your tracker doesn't report it.",
  },
  {
    key: "scratching",
    label: "Scratching / Itch",
    dimension: "duration",
    direction: "high_bad",
    alert: true,
    species: ["dog", "cat"],
    help: "Time spent scratching. A sustained rise often precedes a visible skin or allergy problem.",
  },
  {
    key: "barking_events",
    label: "Barking",
    dimension: "count",
    direction: "high_bad",
    alert: false,
    species: ["dog"],
  },
  {
    key: "wear_time",
    label: "Collar Wear Time",
    dimension: "duration",
    direction: "low_bad",
    alert: false,
    species: ["dog", "cat"],
    help: "How long the tracker was worn. Low wear explains dips in every other metric — check this first.",
  },
];

const BY_KEY = new Map(REGISTRY.map((m) => [m.key, m]));

export function metric(key: string): MetricDef | undefined {
  return BY_KEY.get(key);
}

/** Metrics meaningful for a species AND supported by that pet's hardware. */
export function availableMetrics(species: Species, capabilities: string[]): MetricDef[] {
  const cap = new Set(capabilities);
  return REGISTRY.filter((m) => cap.has(m.key) && (species === "unknown" || m.species.includes(species)));
}

/** True if `key` names a metric an adapter is allowed to emit. */
export function isKnownMetric(key: string): boolean {
  return BY_KEY.has(key);
}
