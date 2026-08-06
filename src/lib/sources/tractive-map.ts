/**
 * Pure payload → canonical readings mapping for the Tractive adapter.
 *
 * Kept separate from the network client so the awkward part — which vendor
 * field means what, and in which unit — is testable against recorded fixtures
 * with no account and no requests.
 *
 * Every mapping here is explicit. The predecessor matched flattened payload
 * paths with regexes, which cannot know the source unit and can bind an
 * unrelated field to a chart a vet will read.
 */

import type { Reading } from "./types";

/** Vendor day-overview kinds this adapter understands. */
export type DayKind = "activity" | "sleep" | "scratch" | "bark";

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

function push(out: Reading[], petKey: string, date: string, metric: string, value: number | null) {
  if (value !== null) out.push({ petKey, date, metric, value });
}

/**
 * Collar wear time in canonical minutes, from the gaps the tracker reported no
 * data for.
 *
 * `daySeconds` must be the real length of that local day — a DST day is 23 or
 * 25 hours, and assuming 86400 shifts wear by an hour, which matters because
 * wear decides whether the day's other totals are trustworthy at all.
 */
export function wearMinutes(noDataGaps: { durationSeconds?: number }[], daySeconds: number): number {
  // Negative durations are corrupt, not credit: summing them raw produced more
  // wear than the day contains (1500 minutes of a 1440-minute day).
  const off = noDataGaps.reduce((sum, g) => sum + Math.max(0, num(g.durationSeconds) ?? 0), 0);
  const worn = Math.max(0, daySeconds - Math.min(off, daySeconds));
  return Math.round((worn / 60) * 10) / 10;
}

export function mapDayOverview(
  kind: DayKind,
  payload: Record<string, unknown> | null,
  petKey: string,
  date: string,
  daySeconds: number
): Reading[] {
  if (!payload) return [];
  const out: Reading[] = [];

  if (kind === "activity") {
    const dist = (payload.activityDistribution ?? []) as { category?: string; current?: number }[];
    for (const d of dist) {
      const v = num(d.current);
      if (d.category === "ACTIVE") push(out, petKey, date, "active_minutes", v);
      if (d.category === "RESTING") push(out, petKey, date, "rest_minutes", v);
      if (d.category === "CALORIES") push(out, petKey, date, "calories", v);
    }
  }

  if (kind === "sleep") {
    push(out, petKey, date, "sleep_score", num(payload.nightSleepScore));
    push(
      out,
      petKey,
      date,
      "sleep_interruptions",
      num((payload.nightSleepInterruptions as { count?: number } | null)?.count)
    );
    const ov = payload.overview as Record<string, { minutes?: number }> | undefined;
    push(out, petKey, date, "night_sleep_minutes", num(ov?.nightSleep?.minutes));
    push(out, petKey, date, "day_sleep_minutes", num(ov?.daySleep?.minutes));
    push(out, petKey, date, "calm_minutes", num(ov?.calm?.minutes));
  }

  if (kind === "scratch") {
    // The registry stores durations in minutes; the vendor reports seconds.
    // Converting here is exactly what an explicit map is for.
    const seconds = num(payload.secondsScratch);
    push(out, petKey, date, "scratching", seconds === null ? null : seconds / 60);

    // Wear is derived from the gaps the tracker reported. If it reported no
    // gap list at all, that is missing information — emitting a full day would
    // certify perfect wear on the strength of absent data, and wear is the
    // metric everything else is judged against.
    const events = payload.events as Record<string, unknown> | undefined;
    const gaps = Array.isArray(events?.noData)
      ? (events.noData as { durationSeconds?: number }[])
      : null;
    if (gaps) push(out, petKey, date, "wear_time", wearMinutes(gaps, daySeconds));
  }

  if (kind === "bark") {
    push(out, petKey, date, "barking_events", num(payload.average));
  }

  return out;
}

/**
 * Biometric day overviews carry a 7-day lookback, which is how a missed day
 * heals itself without a separate backfill pass.
 */
export interface BiometricPayload {
  average?: number;
  lookback?: { days?: { dayOffset: number; average: number | null }[] };
}

export function mapBiometric(
  payload: BiometricPayload | null,
  metric: string,
  petKey: string,
  date: string,
  shift: (date: string, days: number) => string
): Reading[] {
  if (!payload) return [];
  const out: Reading[] = [];
  const days = payload.lookback?.days ?? [];
  for (const d of days) {
    const v = num(d.average);
    // dayOffset is relative to the requested date and is zero or negative.
    if (v !== null) out.push({ petKey, date: shift(date, d.dayOffset), metric, value: v });
  }
  // Fall back when the lookback did not produce a USABLE value for the
  // requested day. Testing only for the presence of offset zero discarded a
  // perfectly good top-level average whenever that entry existed but was null.
  if (!out.some((r) => r.date === date)) {
    push(out, petKey, date, metric, num(payload.average));
  }
  return out;
}

/**
 * Profile weight, reported in grams — already the canonical unit for mass.
 *
 * The profile carries no date: it is whatever the owner last typed in. It may
 * therefore only be attributed to the current day. Letting the caller supply
 * any date meant a backwards history import could stamp today's weight onto
 * every day it walked, fabricating a flat weight history — for the metric a vet
 * looks at first.
 */
export function mapProfileWeight(
  details: Record<string, unknown>,
  petKey: string,
  date: string,
  today: string
): Reading[] {
  if (date !== today) return [];
  const grams = num((details.details as Record<string, unknown> | undefined)?.weight);
  if (grams === null || grams <= 0) return [];
  return [{ petKey, date, metric: "weight", value: grams }];
}

/**
 * Which metrics a tracker can actually produce, from its declared capabilities.
 * Used to hide unsupported charts rather than draw empty ones — "no barking
 * data" must not read as "no barking".
 */
export function capabilitiesToMetrics(caps: string[]): string[] {
  const has = (c: string) => caps.includes(c);
  // Only metrics some mapper in this adapter can actually produce. "distance"
  // was advertised while nothing emitted it, so a consumer would show an
  // always-empty Distance chart — which reads as "the dog did not move".
  const out = ["active_minutes", "rest_minutes", "calories", "weight"];
  if (has("VITALITY_TRACKING")) out.push("resting_heart_rate", "resting_respiratory_rate");
  if (has("SLEEP_TRACKING"))
    out.push("sleep_score", "night_sleep_minutes", "day_sleep_minutes", "calm_minutes", "sleep_interruptions");
  if (has("BARK_DETECTION")) out.push("barking_events");
  if (has("SCRATCH_DETECTION")) out.push("scratching", "wear_time");
  return [...new Set(out)];
}
