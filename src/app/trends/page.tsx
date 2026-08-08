import Link from "next/link";
import { requireSession } from "@/lib/session";
import NotConfigured from "@/components/NotConfigured";
import { ensureSchema } from "@/lib/db";
import { readSettings } from "@/lib/settings";
import { listPets, readSeries } from "@/lib/store";
import { availableMetrics, metric as metricDef, type Species } from "@/lib/metrics";
import type { DayPoint } from "@/lib/baseline";
import { buildYoY, rollingAvg, totalSleepSeries } from "@/lib/trends";
import { toDisplay, unitLabel } from "@/lib/units";
import type { BandPoint } from "@/lib/chart";
import { localDate } from "@/lib/time";
import TrendChart from "@/components/TrendChart";
import YoYChart from "@/components/YoYChart";

export const dynamic = "force-dynamic";

/**
 * The long view.
 *
 * The dashboard answers "is anything wrong now?" over 90 days. This answers
 * "has anything been slowly changing since spring?", which is the question the
 * README opens with and the one a 7-day vendor app cannot reach.
 *
 * Rolling averages rather than raw days, because a slow drift is invisible
 * under daily noise — and a year-over-year overlay, because "lower than
 * usual" and "lower than this time last year" are different questions when a
 * pet's activity is seasonal.
 */

/** Enough history that a 30-day rolling average and a year overlay mean something. */
const MIN_DAYS_FOR_LONG_VIEW = 60;

function toChart(series: DayPoint[]): BandPoint[] {
  // No band: this is a smoothed line, and drawing a "usual range" around an
  // average of averages would imply a comparison that was never computed.
  return series.map((p) => ({
    date: p.date,
    value: p.value,
    baseLow: null,
    baseHigh: null,
    baseMid: null,
    lowWear: false,
  }));
}

export default async function TrendsPage({
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
        <h1 className="text-xl font-bold sm:text-2xl">📈 Long-term trends</h1>
        <p className="text-zinc-600 dark:text-zinc-400">No pet data yet.</p>
        <Link href="/import" className="text-sm underline">Import a spreadsheet</Link>
      </main>
    );
  }

  const pet = pets.find((p) => p.id === params.pet) ?? pets[0];
  const today = localDate(pet.timezone);

  const shown = availableMetrics(pet.species as Species, pet.capabilities);
  const byMetric = new Map<string, DayPoint[]>();
  await Promise.all(
    shown.map(async (m) => byMetric.set(m.key, await readSeries(pet.id, m.key)))
  );

  // Derived, and only for days where both halves exist — a day with afternoon
  // naps and no night reading is not a short night, it is an unknown one.
  const totalSleep = totalSleepSeries(
    byMetric.get("night_sleep_minutes"),
    byMetric.get("day_sleep_minutes")
  );

  const candidates: { key: string; label: string; unit: string; series: DayPoint[] }[] = [
    ...shown.map((m) => ({
      key: m.key,
      label: m.label,
      unit: unitLabel(m.dimension, settings.units),
      series: byMetric.get(m.key) ?? [],
    })),
    { key: "total_sleep_minutes", label: "Total Sleep", unit: "min", series: totalSleep },
  ];

  const sections = candidates
    .filter((c) => c.series.length >= MIN_DAYS_FOR_LONG_VIEW)
    .map((c) => {
      // Converted before smoothing, so the rolling average and the year
      // overlay are both in the units the axis is labelled with.
      const dim = metricDef(c.key)?.dimension ?? "duration";
      const display = c.series.map((p) => ({
        date: p.date,
        value: toDisplay(p.value, dim, settings.units),
      }));
      return {
        ...c,
        rolling: toChart(rollingAvg(display)),
        yoy: buildYoY(display, today),
      };
    });

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">📈 {pet.name} — long-term trends</h1>
          <p className="mt-0.5 text-xs text-zinc-500">
            30-day rolling averages over the whole record, and this year against last.
            Slow drifts show up here long before they are visible day to day.
          </p>
        </div>
        <nav className="flex flex-wrap gap-1.5 text-sm">
          {pets.length > 1 &&
            pets.map((p) => (
              <Link
                key={p.id}
                href={`/trends?pet=${encodeURIComponent(p.id)}`}
                className={`rounded-md px-2 py-1 ${
                  p.id === pet.id ? "bg-indigo-600 text-white" : "bg-zinc-100 dark:bg-zinc-800"
                }`}
              >
                {p.name}
              </Link>
            ))}
          <Link href="/" className="rounded-md bg-zinc-100 px-2 py-1 dark:bg-zinc-800">← Dashboard</Link>
          <Link href={`/report?pet=${encodeURIComponent(pet.id)}`} className="rounded-md bg-zinc-100 px-2 py-1 dark:bg-zinc-800">🧾 Vet report</Link>
        </nav>
      </header>

      {sections.length === 0 ? (
        <section className="rounded-xl border border-zinc-300 bg-zinc-50 p-4 text-sm dark:border-zinc-700 dark:bg-zinc-900">
          ⏳ Nothing has {MIN_DAYS_FOR_LONG_VIEW} days of history yet. A rolling average over
          less than that is just the raw data with extra steps, so this page waits rather
          than drawing a confident-looking line. The dashboard works from day one.
        </section>
      ) : (
        sections.map((sec) => (
          <section key={sec.key} className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <TrendChart title={`${sec.label} — 30-day average`} unit={sec.unit} points={sec.rolling} />
            <YoYChart title={sec.label} unit={sec.unit} rows={sec.yoy} />
          </section>
        ))
      )}
    </main>
  );
}
