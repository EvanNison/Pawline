/**
 * Units.
 *
 * Rule: the database stores one canonical unit per dimension, always. Display
 * and export convert at the edge. Nothing is ever stored in "whatever unit the
 * vendor happened to send" — a number without a declared unit is a bug, and in
 * a health chart it is a dangerous one.
 *
 * Canonical units are SI base where one exists: grams, meters, seconds-free
 * durations in minutes (the interval every pet-wearable reports natively).
 */

export type Dimension =
  | "mass"
  | "distance"
  | "duration"
  | "rate" // per-minute biometrics (heart rate, respiratory rate)
  | "energy"
  | "count"
  | "score"
  | "percent";

export type UnitSystem = "metric" | "imperial";

/** The unit a value is stored in, per dimension. Never varies by user. */
export const CANONICAL: Record<Dimension, string> = {
  mass: "g",
  distance: "m",
  duration: "min",
  rate: "/min",
  energy: "kcal",
  count: "",
  score: "",
  percent: "%",
};

interface Display {
  unit: string;
  /** canonical value -> displayed value */
  from: (v: number) => number;
  /** displayed value -> canonical value (for user input, e.g. weight entry) */
  to: (v: number) => number;
  decimals: number;
}

const IDENTITY = (v: number) => v;

const DISPLAY: Record<Dimension, Record<UnitSystem, Display>> = {
  mass: {
    metric: { unit: "kg", from: (v) => v / 1000, to: (v) => v * 1000, decimals: 2 },
    imperial: { unit: "lb", from: (v) => v / 453.59237, to: (v) => v * 453.59237, decimals: 1 },
  },
  distance: {
    metric: { unit: "km", from: (v) => v / 1000, to: (v) => v * 1000, decimals: 2 },
    imperial: { unit: "mi", from: (v) => v / 1609.344, to: (v) => v * 1609.344, decimals: 2 },
  },
  duration: {
    metric: { unit: "min", from: IDENTITY, to: IDENTITY, decimals: 0 },
    imperial: { unit: "min", from: IDENTITY, to: IDENTITY, decimals: 0 },
  },
  rate: {
    metric: { unit: "/min", from: IDENTITY, to: IDENTITY, decimals: 0 },
    imperial: { unit: "/min", from: IDENTITY, to: IDENTITY, decimals: 0 },
  },
  energy: {
    metric: { unit: "kcal", from: IDENTITY, to: IDENTITY, decimals: 0 },
    imperial: { unit: "kcal", from: IDENTITY, to: IDENTITY, decimals: 0 },
  },
  count: {
    metric: { unit: "", from: IDENTITY, to: IDENTITY, decimals: 0 },
    imperial: { unit: "", from: IDENTITY, to: IDENTITY, decimals: 0 },
  },
  score: {
    metric: { unit: "", from: IDENTITY, to: IDENTITY, decimals: 0 },
    imperial: { unit: "", from: IDENTITY, to: IDENTITY, decimals: 0 },
  },
  percent: {
    metric: { unit: "%", from: IDENTITY, to: IDENTITY, decimals: 0 },
    imperial: { unit: "%", from: IDENTITY, to: IDENTITY, decimals: 0 },
  },
};

export function displaySpec(dim: Dimension, system: UnitSystem): Display {
  return DISPLAY[dim][system];
}

/** Canonical -> display number, rounded for presentation. */
export function toDisplay(value: number, dim: Dimension, system: UnitSystem): number {
  const d = DISPLAY[dim][system];
  const f = 10 ** d.decimals;
  return Math.round(d.from(value) * f) / f;
}

/** Display -> canonical, for values typed in by a human. Not rounded. */
export function toCanonical(value: number, dim: Dimension, system: UnitSystem): number {
  return DISPLAY[dim][system].to(value);
}

/** "12.4 kg" / "27.3 lb" — the string a chart axis or report cell shows. */
export function format(value: number, dim: Dimension, system: UnitSystem): string {
  const d = DISPLAY[dim][system];
  const n = toDisplay(value, dim, system).toFixed(d.decimals);
  return d.unit ? `${n} ${d.unit}` : n;
}

export function unitLabel(dim: Dimension, system: UnitSystem): string {
  return DISPLAY[dim][system].unit;
}
