import Link from "next/link";
import { requireSession } from "@/lib/session";
import NotConfigured from "@/components/NotConfigured";
import { ensureSchema } from "@/lib/db";
import { readSettings } from "@/lib/settings";
import { listPets, readSeries } from "@/lib/store";
import {
  availableMetrics,
  metric as metricDef,
  MIN_WEAR_MINUTES,
  WEAR_SENSITIVE,
  type Species,
} from "@/lib/metrics";
import type { DayPoint } from "@/lib/baseline";
import { pctChange, rollingAvg, totalSleepSeries } from "@/lib/trends";
import { toDisplay, unitLabel } from "@/lib/units";
import type { BandPoint } from "@/lib/chart";
import { addDays, localDate } from "@/lib/time";
import TrendChart from "@/components/TrendChart";
import PrintButton from "@/components/PrintButton";

export const dynamic = "force-dynamic";

/**
 * One page to take to the vet.
 *
 * The dashboard answers "is anything wrong today". A consultation needs the
 * other thing: what these numbers used to be. "Resting heart rate is 72" means
 * nothing to a vet who has never met this animal; "72 now, 61 a year ago, on a
 * collar worn daily throughout" is a conversation.
 *
 * Everything here is an average over a window, never a single day, and every
 * window states how many days it had. A number computed from three readings
 * printed beside one computed from thirty would be read as equally solid.
 */

/** A window needs at least this many days before its average is printed. */
const MIN_DAYS_FOR_AVERAGE = 5;
/** Year-over-year shift, in the concerning direction, worth drawing attention to. */
const FLAG_PCT = 15;

/** Metrics worth putting in front of a vet, and which direction is the worrying one. */
const REPORT_METRICS: { key: string; watch?: "high" | "low" }[] = [
  { key: "resting_heart_rate", watch: "high" },
  { key: "resting_respiratory_rate", watch: "high" },
  { key: "active_minutes", watch: "low" },
  { key: "total_sleep_minutes", watch: "low" },
  { key: "sleep_score", watch: "low" },
  { key: "sleep_interruptions", watch: "high" },
  { key: "scratching", watch: "high" },
  { key: "weight" },
];

/** Mean over a half-open window, or null when too few days to be worth printing. */
function avg(series: DayPoint[], from: string, to: string): { value: number; days: number } | null {
  const vals = series.filter((p) => p.date >= from && p.date < to).map((p) => p.value);
  if (vals.length < MIN_DAYS_FOR_AVERAGE) return null;
  return {
    value: Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10,
    days: vals.length,
  };
}

export default async function ReportPage({
  searchParams,
}: {
  searchParams: Promise<{ pet?: string }>;
}) {
  await requireSession();
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) return <NotConfigured />;

  await ensureSchema();
  const params = await searchParams;
  const settings = await readSettings();
  const pets = await listPets();
  if (pets.length === 0) {
    return (
      <main className="mx-auto max-w-2xl space-y-4 p-4 sm:p-6">
        <h1 className="text-xl font-bold sm:text-2xl">🩺 Health trend report</h1>
        <p className="text-zinc-600 dark:text-zinc-400">No pet data yet.</p>
        <Link href="/import" className="text-sm underline">Import a spreadsheet</Link>
      </main>
    );
  }

  const pet = pets.find((p) => p.id === params.pet) ?? pets[0];
  const today = localDate(pet.timezone);
  const available = new Set(availableMetrics(pet.species as Species, pet.capabilities).map((m) => m.key));

  const byMetric = new Map<string, DayPoint[]>();
  await Promise.all(
    [...available].map(async (key) => byMetric.set(key, await readSeries(pet.id, key)))
  );
  byMetric.set(
    "total_sleep_minutes",
    totalSleepSeries(byMetric.get("night_sleep_minutes"), byMetric.get("day_sleep_minutes"))
  );

  // Days the collar was barely worn undercount every elapsed-time total. The
  // dashboard shades them; a report that averaged them in would turn a fortnight
  // of nighttime collar removal into a real-looking decline in sleep.
  const lowWear = new Set(
    (byMetric.get("wear_time") ?? []).filter((p) => p.value < MIN_WEAR_MINUTES).map((p) => p.date)
  );

  const rows = REPORT_METRICS.filter(
    (m) => m.key === "total_sleep_minutes" || available.has(m.key)
  )
    .map((m) => {
      const def = metricDef(m.key);
      const dim = def?.dimension ?? "duration";
      const all = byMetric.get(m.key) ?? [];
      const series = WEAR_SENSITIVE.has(m.key) ? all.filter((p) => !lowWear.has(p.date)) : all;
      const shown = series.map((p) => ({ date: p.date, value: toDisplay(p.value, dim, settings.units) }));

      const last30 = avg(shown, addDays(today, -29), addDays(today, 1));
      const sixMo = avg(shown, addDays(today, -210), addDays(today, -150));
      const yearAgo = avg(shown, addDays(today, -395), addDays(today, -335));
      const change = pctChange(last30?.value ?? null, yearAgo?.value ?? null);
      const flagged =
        change !== null &&
        Math.abs(change) >= FLAG_PCT &&
        ((m.watch === "high" && change > 0) || (m.watch === "low" && change < 0));

      return {
        key: m.key,
        label: m.key === "total_sleep_minutes" ? "Total Sleep" : (def?.label ?? m.key),
        unit: m.key === "total_sleep_minutes" ? "min" : unitLabel(dim, settings.units),
        series: shown,
        last30,
        sixMo,
        yearAgo,
        change,
        flagged,
      };
    })
    .filter((r) => r.last30 !== null);

  const flaggedRows = rows.filter((r) => r.flagged);
  const comparable = rows.filter((r) => r.change !== null);
  const charted = rows.filter((r) => r.series.length >= 60).slice(0, 4);

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6 print:p-2">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">🩺 Health trend report — {pet.name}</h1>
          <p className="text-sm text-zinc-500">
            Generated {today} · {settings.units} units · from a consumer activity tracker,
            recorded daily
          </p>
        </div>
        <div className="flex gap-2 print:hidden">
          <Link href="/" className="rounded-md bg-zinc-100 px-2 py-1.5 text-sm dark:bg-zinc-800">← Dashboard</Link>
          <PrintButton />
        </div>
      </header>

      {flaggedRows.length > 0 ? (
        <section className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
          <h2 className="mb-1 font-semibold">
            Year-over-year changes of {FLAG_PCT}% or more, in the direction usually worth asking about
          </h2>
          <ul className="list-inside list-disc">
            {flaggedRows.map((r) => (
              <li key={r.key}>
                <b>{r.label}</b>: {r.yearAgo!.value} → {r.last30!.value} {r.unit} (
                {r.change! > 0 ? "+" : ""}
                {r.change}%)
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs">
            Observations from consumer-collar data. Context for a veterinarian, not a
            diagnosis, and not a reason to assume anything is wrong.
          </p>
        </section>
      ) : comparable.length === 0 ? (
        <section className="rounded-xl border border-zinc-300 bg-zinc-50 p-4 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
          Not enough history for a year-over-year comparison yet — this fills in once
          there is data from about a year ago. <b>This is not a statement that nothing
          has changed.</b>
        </section>
      ) : (
        <section className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100">
          No measurement shifted {FLAG_PCT}% or more year-over-year in a concerning
          direction — across the {comparable.length} of {rows.length} with enough history
          to compare.
        </section>
      )}

      <section className="overflow-x-auto print:overflow-visible">
        <h2 className="mb-2 text-sm font-semibold">Averages over time</h2>
        <table className="w-full min-w-[32rem] text-left text-sm print:min-w-0">
          <thead>
            <tr className="border-b border-zinc-300 text-xs text-zinc-500 dark:border-zinc-700">
              <th className="py-1">Measurement</th>
              <th>Last 30 days</th>
              <th>~6 months ago</th>
              <th>~1 year ago</th>
              <th>Change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.key}
                className={`border-b border-zinc-100 dark:border-zinc-800 ${
                  r.flagged ? "bg-amber-50 dark:bg-amber-950" : ""
                }`}
              >
                <td className="py-1.5 font-medium">{r.label}</td>
                <td>
                  {r.last30!.value} {r.unit}{" "}
                  <span className="text-xs text-zinc-400">({r.last30!.days}d)</span>
                </td>
                <td>{r.sixMo ? `${r.sixMo.value}` : "—"}</td>
                <td>{r.yearAgo ? `${r.yearAgo.value}` : "—"}</td>
                <td>{r.change === null ? "—" : `${r.change > 0 ? "+" : ""}${r.change}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-xs text-zinc-500">
          A cell reads &ldquo;—&rdquo; when fewer than {MIN_DAYS_FOR_AVERAGE} days were
          available, rather than showing an average of one or two.
          {lowWear.size > 0 && (
            <>
              {" "}
              {lowWear.size} day{lowWear.size === 1 ? "" : "s"} when the tracker was worn
              too little are excluded from totals and counts — on those days the figure is
              unknown, not low.
            </>
          )}
        </p>
      </section>

      {charted.length > 0 && (
        <section className="grid grid-cols-1 gap-4 md:grid-cols-2 print:grid-cols-2">
          {charted.map((r) => {
            const points: BandPoint[] = rollingAvg(
              r.series.filter((p) => p.date >= addDays(today, -456))
            ).map((p) => ({
              date: p.date,
              value: p.value,
              baseLow: null,
              baseHigh: null,
              baseMid: null,
              lowWear: false,
            }));
            return (
              <TrendChart
                key={r.key}
                title={`${r.label} — 30-day average`}
                unit={r.unit}
                points={points}
              />
            );
          })}
        </section>
      )}

      <p className="text-xs text-zinc-500">
        Pawline reports changes in numbers from a consumer device. It cannot diagnose
        anything, has not been clinically validated, and a quiet report is not evidence of
        health. Bring this as background to a conversation with a vet, not as a conclusion.
      </p>
    </main>
  );
}
