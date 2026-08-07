/**
 * User-facing settings, and the ones deliberately withheld.
 *
 * Exposed: units, alert email, per-metric mute. These are preferences.
 *
 * NOT exposed: the statistical parameters — sigma, the baseline window, the
 * 2-of-3 persistence rule, the wear threshold, the minimum history. They are
 * calibrated together, and a control labelled "sensitivity" would let someone
 * quietly make the tool miss things, which is the failure it exists to prevent.
 * If one is wrong, change it in code with a test pinning the new behaviour.
 *
 * Timezone is also withheld from casual editing: it decides which day every
 * reading belongs to, so changing it mid-history retroactively re-partitions
 * data that is already stored. It is set once, at setup.
 */

import { sql } from "./db";
import type { UnitSystem } from "./units";
import type { Species } from "./metrics";
import { isValidTimezone } from "./time";

export interface Settings {
  units: UnitSystem;
  timezone: string;
  species: Species;
  alertEmail: string | null;
  /**
   * Metrics whose *notifications* are muted. Detection still runs and the
   * history still records it — muting must never suppress the row, or a
   * muted metric becomes an invisible state, which is the bug class this
   * project keeps rediscovering.
   */
  mutedMetrics: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  units: "metric",
  timezone: "UTC",
  species: "unknown",
  alertEmail: null,
  mutedMetrics: [],
};

export async function readSettings(): Promise<Settings> {
  const rows = await sql()`select key, value from app_config`;
  const map = new Map(rows.map((r) => [r.key as string, r.value as string]));

  const units = map.get("units");
  const timezone = map.get("timezone");
  let muted: string[] = [];
  try {
    muted = JSON.parse(map.get("muted_metrics") ?? "[]");
    if (!Array.isArray(muted)) muted = [];
  } catch {
    muted = [];
  }

  return {
    units: units === "imperial" ? "imperial" : "metric",
    // Fall back rather than trust a stored value: an invalid zone would throw
    // inside Intl on every page, and a broken settings row must not take the
    // whole app down.
    timezone: timezone && isValidTimezone(timezone) ? timezone : DEFAULT_SETTINGS.timezone,
    species: (["dog", "cat"] as const).includes(map.get("species") as "dog" | "cat")
      ? (map.get("species") as Species)
      : "unknown",
    alertEmail: map.get("alert_email") ?? null,
    mutedMetrics: muted.filter((m) => typeof m === "string"),
  };
}

export async function writeSetting(key: string, value: string): Promise<void> {
  await sql()`insert into app_config (key, value) values (${key}, ${value})
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
}

/**
 * Whether the timezone has been chosen yet.
 *
 * Distinguished from "it is UTC" so setup can ask once and never silently
 * assume — a wrong timezone shifts every day boundary in the history.
 */
export async function timezoneIsSet(): Promise<boolean> {
  const [row] = await sql()`select value from app_config where key = 'timezone'`;
  return Boolean(row?.value);
}
