import { requireSession } from "@/lib/session";
import NotConfigured from "@/components/NotConfigured";
import Link from "next/link";
import { ensureSchema, sql } from "@/lib/db";
import { readSettings } from "@/lib/settings";
import { listPets, readJournal, readSeries } from "@/lib/store";
import { availableMetrics, MIN_WEAR_MINUTES, WEAR_SENSITIVE, type Species } from "@/lib/metrics";
import { ACCRUING, alertSeries, isAlertVisible } from "@/lib/alerting";
import { hasSufficientHistory } from "@/lib/baseline";
import { buildChart } from "@/lib/chart";
import { assessability, STALE_AFTER_DAYS } from "@/lib/health";
import { localDate, addDays } from "@/lib/time";
import TrendChart from "@/components/TrendChart";
import QuickLog from "@/components/QuickLog";
import HealthSummary from "@/components/HealthSummary";
import {
  SUMMARY_RANGES,
  vitalsOn,
  comfortOn,
  readinessOn,
  flaggedStreak,
  longTrend,
  monthlyMedians,
  contextFor,
  type JournalEntry as CompositeJournalEntry,
} from "@/lib/composites";
import { unitLabel } from "@/lib/units";

export const dynamic = "force-dynamic";

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ pet?: string; sr?: string }>;
}) {
  await requireSession();
  // The same component every other page uses. A second, vaguer wording here
  // ("see the README") sent the one person most likely to be stuck — someone
  // on their first deploy, landing on the home page — somewhere less useful
  // than the other three pages did.
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) {
    return <NotConfigured />;
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
          No pet data yet. Import a spreadsheet to see something immediately, or connect a
          tracker to collect automatically from now on.
        </p>
        {/* Import leads, because it is the option that works for everyone and
            asks for nothing. Connecting a tracker means accepting a vendor's
            terms, which should be a considered choice rather than the only door. */}
        <div className="flex flex-wrap gap-2 text-sm">
          <Link href="/import" className="rounded-md bg-indigo-600 px-3 py-1.5 text-white">📄 Import a spreadsheet</Link>
          <Link href="/setup" className="rounded-md bg-zinc-100 px-3 py-1.5 dark:bg-zinc-800">⚙️ Connect a tracker</Link>
          <Link href="/status" className="rounded-md bg-zinc-100 px-3 py-1.5 dark:bg-zinc-800">🩹 Status</Link>
        </div>
      </main>
    );
  }

  // Selectable, not just pets[0]. With two animals the dashboard showed
  // whichever sorted first and offered no way to reach the other, so an alert
  // raised for the second pet was invisible here and on /alerts -- present in
  // the database, correctly emailed, and unreachable in the interface.
  const params = await searchParams;
  const pet = pets.find((p) => p.id === params.pet) ?? pets[0];
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

  /**
   * A metric counts as assessable only if it has enough history AND a recent
   * reading.
   *
   * Depth alone was the bug: a baseline built from months of data stays
   * confident forever, so a collector that died in March would still have
   * produced a green "nothing unusual" tick in August. That is the precise
   * failure this project claims to prevent — the one that looks like health.
   */
  const { assessable, building, stale } = assessability(
    alertable.map((m) => {
      const series = alertSeries(seriesByMetric.get(m.key) ?? [], m.key, {
        today,
        lowWear: lowWearDates,
      });
      return {
        hasHistory: hasSufficientHistory(series),
        newest: series.filter((p) => p.value !== null).at(-1)?.date ?? null,
      };
    }),
    today
  );

  const notes = await readJournal(pet.id, 8);

  // ---- "Readings judged together" cards. In addition to every single-metric
  // alert and chart, never instead of them. Same filtering as alerting, so a
  // low-wear day or today's unfinished total never counts.
  const summaryRange = SUMMARY_RANGES.some(([r]) => r === Number(params.sr)) ? Number(params.sr) : 14;
  const alertMap = new Map(
    alertable.map((m) => [
      m.key,
      alertSeries(seriesByMetric.get(m.key) ?? [], m.key, { today, lowWear: lowWearDates }),
    ])
  );
  // Complete days only (today is still accruing), oldest first.
  const stripDays = Array.from({ length: summaryRange }, (_, i) => addDays(today, i - summaryRange));
  const vitalsDays = stripDays.map((d) => vitalsOn(alertMap, d));
  const comfortDays = stripDays.map((d) => comfortOn(alertMap, d));
  const readinessDays = stripDays.map((d) => readinessOn(alertMap, d));
  const longTerm = (["resting_respiratory_rate", "resting_heart_rate"] as const)
    .filter((k) => seriesByMetric.has(k))
    .map((k) => ({
      label: k === "resting_respiratory_rate" ? "Resting breathing" : "Resting heart rate",
      unit: k === "resting_respiratory_rate" ? "breaths/min" : "bpm",
      trend: longTrend(seriesByMetric.get(k), today),
      months: monthlyMedians(seriesByMetric.get(k)),
    }));
  const contextEntries: CompositeJournalEntry[] = (
    await readJournal(pet.id, 500, addDays(stripDays[0], -3))
  ).map((e) => ({ date: e.date, category: e.category, note: e.note }));
  contextEntries.sort((a, b) => a.date.localeCompare(b.date));
  const hasContext = stripDays.map((d) => contextFor(contextEntries, d).length > 0);
  const context = contextEntries.filter((e) => stripDays.some((d) => contextFor([e], d).length > 0));

  const alertRows = await s`select id, date::text as date, metric, direction, value,
      baseline_median, severity, acknowledged, emailed, resolved, note, muted
    from alerts where pet_id = ${pet.id} order by date desc limit 200`;
  const visible = alertRows.filter((a) =>
    isAlertVisible({
      date: a.date as string,
      emailed: Boolean(a.emailed),
      acknowledged: Boolean(a.acknowledged),
      resolved: Boolean(a.resolved),
    })
  );

  // Dismissing silences a warning; it does not end the condition. Counting
  // these separately is what stops the page going green over an episode the
  // app still believes is running — the owner asked not to be shouted at, not
  // to be told everything is fine.
  const dismissedButOpen = alertRows.filter((a) => a.acknowledged && !a.resolved).length;

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">🐾 {pet.name}</h1>
          <p className="text-xs text-zinc-500">Long-term health trends · {settings.units} units</p>
        </div>
        <nav className="flex flex-wrap gap-1.5 text-sm">
          {pets.length > 1 &&
            pets.map((p) => (
              <Link
                key={p.id}
                href={`/?pet=${encodeURIComponent(p.id)}`}
                className={`rounded-md px-2 py-1 ${
                  p.id === pet.id ? "bg-indigo-600 text-white" : "bg-zinc-100 dark:bg-zinc-800"
                }`}
              >
                {p.name}
              </Link>
            ))}
          <Link href={`/alerts?pet=${encodeURIComponent(pet.id)}`} className="rounded-md bg-zinc-100 px-2 py-1 dark:bg-zinc-800">🔔 Alerts</Link>
          <Link href={`/status?pet=${encodeURIComponent(pet.id)}`} className="rounded-md bg-zinc-100 px-2 py-1 dark:bg-zinc-800">🩹 Status</Link>
          <Link href={`/trends?pet=${encodeURIComponent(pet.id)}`} className="rounded-md bg-zinc-100 px-2 py-1 dark:bg-zinc-800">📈 Trends</Link>
          <Link href={`/report?pet=${encodeURIComponent(pet.id)}`} className="rounded-md bg-zinc-100 px-2 py-1 dark:bg-zinc-800">🩺 Vet report</Link>
          <Link href={`/import?pet=${encodeURIComponent(pet.id)}`} className="rounded-md bg-zinc-100 px-2 py-1 dark:bg-zinc-800">📄 Import</Link>
          <Link href={`/setup?pet=${encodeURIComponent(pet.id)}`} className="rounded-md bg-zinc-100 px-2 py-1 dark:bg-zinc-800">⚙️ Setup</Link>
        </nav>
      </header>

      {visible.length === 0 ? (
        stale > 0 ? (
          // Ranked above the green tick deliberately: stale data is the failure
          // that looks like health, so it must not be reported underneath a
          // reassuring headline.
          <section className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
            ⚠️ {stale} measurement{stale === 1 ? " has" : "s have"} stopped arriving — nothing
            new for more than {STALE_AFTER_DAYS} days. Nothing can be judged from readings
            that are not coming in, so this is <strong>not</strong> a statement that
            everything is normal. See <Link href="/status" className="underline">Status</Link>.
          </section>
        ) : assessable === 0 ? (
          <section className="rounded-xl border border-zinc-300 bg-zinc-50 p-4 text-sm dark:border-zinc-700 dark:bg-zinc-900">
            ⏳ Not enough history to judge anything yet — a baseline needs about three
            weeks of readings per measurement. This is not a statement that everything
            is normal.
          </section>
        ) : dismissedButOpen > 0 ? (
          <section className="rounded-xl border border-zinc-300 bg-zinc-50 p-4 text-sm dark:border-zinc-700 dark:bg-zinc-900">
            🔕 {dismissedButOpen} alert{dismissedButOpen === 1 ? "" : "s"} you dismissed{" "}
            {dismissedButOpen === 1 ? "is" : "are"} still open — the measurement has not
            returned to its usual range. Nothing new is being flagged, which is not the
            same as everything being normal.{" "}
            <Link href={`/alerts?pet=${encodeURIComponent(pet.id)}`} className="underline">See alerts</Link>.
          </section>
        ) : (
          <section className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100">
            ✅ Nothing unusual in the {assessable} measurement{assessable === 1 ? "" : "s"} with
            enough history to assess, all current to the last {STALE_AFTER_DAYS} days
            {building > 0 && <> ({building} still building up history)</>}.
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

      {/* Directly under the verdict, above the charts: the two things a tracker
          cannot record, put where someone will actually see them rather than on
          a settings page they visit once. */}
      <QuickLog petId={pet.id} weightUnit={unitLabel("mass", settings.units)} />

      <HealthSummary
        petId={pet.id}
        summaryRange={summaryRange}
        days={stripDays}
        hasContext={hasContext}
        vitals={vitalsDays}
        vitalsStreak={flaggedStreak(vitalsDays)}
        readiness={readinessDays}
        comfort={comfortDays}
        longTerm={longTerm}
        context={context}
      />

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2">
        {charts.map((c) => (
          <TrendChart key={c.metric} title={c.label} unit={c.unit} points={c.points} />
        ))}
      </section>

      {notes.length > 0 && (
        // Shown beneath the charts, because a note's whole purpose is to explain
        // one of them. Written and never displayed, this was a careful way to
        // lose information.
        <section className="rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-800">
          <h2 className="font-semibold">Recent notes</h2>
          <ul className="mt-2 space-y-1 text-zinc-600 dark:text-zinc-400">
            {notes.map((n) => (
              <li key={n.id}>
                <span className="text-zinc-400">{n.date}</span>{" "}
                <span className="rounded bg-zinc-100 px-1 text-xs dark:bg-zinc-800">{n.category}</span>{" "}
                {n.note}
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="text-xs text-zinc-500">
        Trends from a consumer tracker, compared against {pet.name}&apos;s own usual ranges.
        Not a diagnosis, and not a substitute for a vet.
      </p>
    </main>
  );
}
