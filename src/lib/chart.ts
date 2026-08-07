/**
 * Chart band construction.
 *
 * Ported from the predecessor, where every rule below was a bug found by
 * looking at the running dashboard rather than by a test — impossible band
 * ranges, a cliff to zero at the right-hand edge, a band resurrected after its
 * evidence expired. Kept out of the page component precisely so those are
 * reachable from a test here.
 *
 * The one addition for this codebase: values are stored canonically (grams,
 * meters, minutes) and converted for display, so the chart returns both.
 */

import { type Baseline, type DayPoint, rollingBaseline, spreadOf } from "./baseline";
import { clampToRange, metric as metricDef } from "./metrics";
import { toDisplay, unitLabel, type UnitSystem } from "./units";

/**
 * Days a carried-forward band stays valid before it is treated as unknown.
 *
 * A 60-day median is slow-moving — a pet's normal resting heart rate does not
 * shift in a fortnight — so carrying it across a stretch of excluded days (a
 * holiday with the collar off) is honest. Carrying it across a months-long gap
 * is not: by then it describes a different animal's year.
 */
export const MAX_BAND_CARRY_DAYS = 14;

const SIGMA = 3;

export interface BandPoint {
  date: string;
  /** In display units, ready to plot. */
  value: number | null;
  baseMid: number | null;
  baseLow: number | null;
  baseHigh: number | null;
  lowWear: boolean;
}

export interface Chart {
  metric: string;
  label: string;
  /** The unit the values are in, for the axis. */
  unit: string;
  points: BandPoint[];
}

export interface BuildChartOptions {
  units: UnitSystem;
  /** Shaded for every metric — purely informational. */
  lowWearDates?: ReadonlySet<string>;
  /**
   * Whether low-wear days should also be kept out of the baseline. True only
   * for elapsed-time totals: excluding them from an average like heart rate
   * would discard valid readings, since a partial day still yields a valid mean.
   */
  excludeLowWearFromBand?: boolean;
  /**
   * Days whose value is still accruing. Plotted as a gap, not a number: a
   * running total is near zero just after midnight, and drawing it as a
   * finished day put a cliff to the floor on the end of every sleep and
   * activity chart — the most alarming shape a health chart can have, from
   * data that simply has not arrived yet.
   */
  incompleteDates?: ReadonlySet<string>;
}

export function buildChart(
  metricKey: string,
  series: DayPoint[],
  allDates: string[],
  opts: BuildChartOptions
): Chart {
  const def = metricDef(metricKey);
  const lowWear = opts.lowWearDates ?? new Set<string>();
  const incomplete = opts.incompleteDates ?? new Set<string>();
  const dim = def?.dimension ?? "count";

  const map = new Map(series.map((p) => [p.date, p.value]));

  // The band is what "normal" looks like, so for totals it must be built only
  // from days the collar was worn — otherwise collar-off days drag the usual
  // range toward values describing an absent tracker, not the pet.
  const basis = opts.excludeLowWearFromBand ? series.filter((p) => !lowWear.has(p.date)) : series;
  const bases = rollingBaseline(basis);

  // Carry each baseline forward so a day excluded from the basis still gets a
  // band — but only briefly, and never past a null. `bases[i] ?? carried` would
  // resurrect an old band exactly when the window stopped having enough
  // evidence to justify one, which is the moment to show nothing instead.
  const byDate = new Map<string, Baseline | null>();
  let cursor = 0;
  let carried: Baseline | null = null;
  let carriedFrom: string | null = null;
  for (const date of [...allDates].sort()) {
    while (cursor < basis.length && basis[cursor].date <= date) {
      carried = bases[cursor];
      carriedFrom = basis[cursor].date;
      cursor++;
    }
    const staleDays =
      carriedFrom === null
        ? Infinity
        : Math.round(
            (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${carriedFrom}T00:00:00Z`)) / 86_400_000
          );
    byDate.set(date, staleDays <= MAX_BAND_CARRY_DAYS ? carried : null);
  }

  const points = allDates.map((date) => {
    const b = byDate.get(date) ?? null;
    const spread = b ? spreadOf(b, b.values) : null;
    const raw = map.get(date);
    const show = (v: number | null) => (v === null ? null : toDisplay(v, dim, opts.units));
    return {
      date,
      value: raw === undefined || incomplete.has(date) ? null : show(raw),
      baseMid: b ? show(b.median) : null,
      // Clamped: a band running below zero wakeups, or above a score of 100,
      // asserts a usual range that includes impossible readings.
      baseLow: b && spread !== null ? show(clampToRange(metricKey, b.median - SIGMA * spread)) : null,
      baseHigh: b && spread !== null ? show(clampToRange(metricKey, b.median + SIGMA * spread)) : null,
      lowWear: lowWear.has(date),
    };
  });

  return {
    metric: metricKey,
    label: def?.label ?? metricKey,
    unit: unitLabel(dim, opts.units),
    points,
  };
}
