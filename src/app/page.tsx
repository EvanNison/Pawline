import Link from "next/link";
import { ensureSchema, sql } from "@/lib/db";
import { readSettings } from "@/lib/settings";
import { listPets, readSeries } from "@/lib/store";
import { availableMetrics, MIN_WEAR_MINUTES, WEAR_SENSITIVE, type Species } from "@/lib/metrics";
import { ACCRUING, alertSeries, isAlertVisible } from "@/lib/alerting";
import { hasSufficientHistory } from "@/lib/baseline";
import { buildChart } from "@/lib/chart";
import { localDate, addDays } from "@/lib/time";
import TrendChart from "@/components/TrendChart";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
    return (
      <main className="mx-auto max-w-2xl p-6">
        <h1 className="text-xl font-bold sm:text-2xl">🐾 Pawline</h1>
        <p className="mt-4 text-zinc-600 dark:text-zinc-400">
          No database configured yet. See the setup guide in the README.
        </p>
      </main>
    );
  }

  await ensureSchema();
  const s = sql();
  const settings = await readSettings();
  const pets = await listPets();

  if (pets.length === 0) {
    return (
      <main className="mx-auto max-w-2xl space-y-4 p-4 sm:p-6">
        <h1 className="text-xl font-bold sm:text-2xl">🐾 Pawline</h1>
        <p className="text-zinc-600 dark:text-zinc-400">
          No pet data yet. Choose where your readings come from, then run a collection.
        </p>
        <div className="flex flex-wrap gap-2 text-sm">
          <Link href="/setup" className="rounded-md bg-indigo-600 px-3 py-1.5 text-white">⚙️ Set up a source</Link>
          <Link href="/status" className="rounded-md bg-zinc-100 px-3 py-1.5 dark:bg-zinc-800">🩹 Status</Link>
        </div>
      </main>
    );
  }

  const pet = pets[0];
  const today = localDate(pet.timezone);
  const species = pet.species as Species;

  // Only metrics this species and this hardware can actually produce. An empty
  // chart reads as "the pet did not do that", which is a false statement.
  const shown = availableMetrics(species, pet.capabilities);

  const seriesByMetric = new Map(
    await Promise.all(shown.map(async (m) => [m.key, await readSeries(pet.id, m.key)] as const))
  );

  const wear = seriesByMetric.get("wear_time") ?? [];
  const lowWearDates = new Set(wear.filter((p) => p.value < MIN_WEAR_MINUTES).map((p) => p.date));
  const incompleteDates = new Set([today]);

  const from = addDays(today, -90);
  const allDates = [
    ...new Set([...seriesByMetric.values()].flat().map((p) => p.date)),
  ].filter((d) => d > from).sort();

  const charts = shown
    .filter((m) => (seriesByMetric.get(m.key)?.length ?? 0) > 0)
    .map((m) =>
      buildChart(m.key, seriesByMetric.get(m.key)!, allDates, {
        units: settings.units,
        lowWearDates,
        excludeLowWearFromBand: WEAR_SENSITIVE.has(m.key),
        incompleteDates: ACCRUING.has(m.key) ? incompleteDates : undefined,
      })
    );

  const alertable = shown.filter((m) => m.alert);
  const assessable = alertable.filter((m) =>
    hasSufficientHistory(
      alertSeries(seriesByMetric.get(m.key) ?? [], m.key, { today, lowWear: lowWearDates })
    )
  ).length;

  const alertRows = await s`select id, date::text as date, metric, direction, value,
      baseline_median, severity, acknowledged, emailed, resolved, note, muted
    from alerts where pet_id = ${pet.id} order by date desc limit 200`;
  const visible = alertRows.filter((a) =>
    isAlertVisible(
      {
        date: a.date as string,
        emailed: Boolean(a.emailed),
        acknowledged: Boolean(a.acknowledged),
        resolved: Boolean(a.resolved),
      },
      today
    )
  );

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">🐾 {pet.name}</h1>
          <p className="text-xs text-zinc-500">Long-term health trends · {settings.units} units</p>
        </div>
        <nav className="flex flex-wrap gap-1.5 text-sm">
          <Link href="/alerts" className="rounded-md bg-zinc-100 px-2 py-1 dark:bg-zinc-800">🔔 Alerts</Link>
          <Link href="/status" className="rounded-md bg-zinc-100 px-2 py-1 dark:bg-zinc-800">🩹 Status</Link>
          <Link href="/setup" className="rounded-md bg-zinc-100 px-2 py-1 dark:bg-zinc-800">⚙️ Setup</Link>
        </nav>
      </header>

      {visible.length === 0 ? (
        assessable === 0 ? (
          <section className="rounded-xl border border-zinc-300 bg-zinc-50 p-4 text-sm dark:border-zinc-700 dark:bg-zinc-900">
            ⏳ Not enough history to judge anything yet — a baseline needs about three
            weeks of readings per measurement. This is not a statement that everything
            is normal.
          </section>
        ) : (
          <section className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100">
            ✅ Nothing unusual in the {assessable} measurement{assessable === 1 ? "" : "s"} with
            enough history to assess
            {alertable.length > assessable && <> ({alertable.length - assessable} still building up history)</>}.
          </section>
        )
      ) : (
        <section className="space-y-2">
          {visible.map((a) => (
            <div
              key={String(a.id)}
              className={`rounded-xl border p-3 text-sm ${
                a.severity === "alert"
                  ? "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100"
                  : "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"
              }`}
            >
              <b>{a.metric as string}</b> {a.note ? String(a.note) : `is ${a.direction} since ${a.date}`}
              {a.muted ? <span className="ml-2 text-xs opacity-70">(notifications muted)</span> : null}
            </div>
          ))}
        </section>
      )}

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {charts.map((c) => (
          <TrendChart key={c.metric} title={c.label} unit={c.unit} points={c.points} />
        ))}
      </section>

      <p className="text-xs text-zinc-500">
        Trends from a consumer tracker, compared against {pet.name}&apos;s own usual ranges.
        Not a diagnosis, and not a substitute for a vet.
      </p>
    </main>
  );
}
