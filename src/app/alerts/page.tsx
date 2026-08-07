import Link from "next/link";
import NotConfigured from "@/components/NotConfigured";
import { ensureSchema, sql } from "@/lib/db";
import { readSettings } from "@/lib/settings";
import { listPets } from "@/lib/store";
import { metric as metricDef } from "@/lib/metrics";
import { format } from "@/lib/units";
import { localDate } from "@/lib/time";

export const dynamic = "force-dynamic";

function statusOf(a: { acknowledged: boolean; resolved: boolean; emailed: boolean; muted: boolean }) {
  if (a.resolved) return { word: "returned to normal", tone: "text-emerald-700 dark:text-emerald-300" };
  if (a.acknowledged) return { word: "dismissed by you", tone: "text-zinc-500" };
  if (a.muted) return { word: "active — notifications muted", tone: "text-zinc-500" };
  if (!a.emailed) return { word: "active — not yet sent", tone: "text-amber-700 dark:text-amber-300" };
  return { word: "active", tone: "text-red-700 dark:text-red-300" };
}

export default async function AlertsPage() {
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) return <NotConfigured />;
  try {
    await ensureSchema();
  } catch (e) {
    // Reachability, not emptiness. A database that cannot be reached must say
    // so rather than rendering as "no data yet", which reads as "your pet has
    // no readings" — a false statement about the pet rather than the app.
    return <NotConfigured detail={String(e).slice(0, 160)} />;
  }
  const s = sql();
  const settings = await readSettings();
  const pets = await listPets();
  if (pets.length === 0) {
    return (
      <main className="mx-auto max-w-2xl p-6">
        <h1 className="text-xl font-bold sm:text-2xl">🔔 Alerts</h1>
        <p className="mt-4 text-zinc-600 dark:text-zinc-400">
          No pet data yet — this fills in after the first collection.
        </p>
      </main>
    );
  }
  const pet = pets[0];
  const today = localDate(pet.timezone);

  const rows = await s`select date::text as date, metric, direction, value, baseline_median,
      severity, days_outside, note, acknowledged, resolved, emailed, muted
    from alerts where pet_id = ${pet.id} order by date desc limit 500`;
  const truncated = rows.length === 500;

  // Coverage belongs beside the history. A quiet stretch can mean nothing was
  // wrong, or that nothing was measured; showing the first without the second
  // lets an outage read as good health.
  const [span] = await s`select min(date)::text as first, max(date)::text as last,
      count(distinct date)::int as days from daily_metrics where pet_id = ${pet.id}`;

  const counts = new Map<string, number>();
  for (const r of rows) if (!r.acknowledged) counts.set(r.metric as string, (counts.get(r.metric as string) ?? 0) + 1);
  const label = (m: string) => metricDef(m)?.label ?? m;
  const show = (m: string, v: unknown) => {
    if (v === null || v === undefined) return "—";
    const def = metricDef(m);
    return def ? format(Number(v), def.dimension, settings.units) : String(v);
  };

  return (
    <main className="mx-auto max-w-4xl space-y-6 p-4 sm:p-6 print:p-2">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold sm:text-2xl">🔔 Everything that has been flagged</h1>
          <p className="text-sm text-zinc-500">{pet.name} · including items that later returned to normal</p>
        </div>
        <nav className="flex gap-2 text-sm print:hidden">
          <Link href="/" className="rounded-md bg-zinc-100 px-2 py-1 dark:bg-zinc-800">← Dashboard</Link>
          <Link href="/status" className="rounded-md bg-zinc-100 px-2 py-1 dark:bg-zinc-800">🩹 Status</Link>
        </nav>
      </header>

      {span?.first && (
        <section className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 text-sm dark:border-zinc-800 dark:bg-zinc-900">
          <b>What this covers.</b> Readings exist for {String(span.days)} days between{" "}
          {String(span.first)} and {String(span.last)}. A stretch with no alerts means nothing
          crossed a threshold <i>on the days that were measured</i> — it says nothing about days
          with no data, or about measurements your tracker does not report.
        </section>
      )}

      {counts.size > 0 ? (
        <section>
          <h2 className="mb-2 text-sm font-semibold text-zinc-500">Summary for a vet</h2>
          <ul className="list-inside list-disc text-sm">
            {[...counts].sort((a, b) => b[1] - a[1]).map(([m, n]) => (
              <li key={m}><b>{label(m)}</b> — flagged {n} {n === 1 ? "time" : "times"}</li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-zinc-500">
            One entry per episode, not per day: several bad days in a row are a single flag.
          </p>
        </section>
      ) : (
        <section className="rounded-xl border border-zinc-300 bg-zinc-50 p-4 text-sm dark:border-zinc-700 dark:bg-zinc-900">
          Nothing has been flagged yet. Alerts only begin once a measurement has about three
          weeks of history behind it.
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-semibold text-zinc-500">
          Every entry
          {truncated && <span className="ml-2 font-normal text-amber-700 dark:text-amber-300">— showing the most recent 500; older entries exist</span>}
        </h2>
        {rows.length === 0 ? (
          <p className="text-sm text-zinc-500">No entries.</p>
        ) : (
          <>
            <ul className="space-y-2 sm:hidden">
              {rows.map((a, i) => {
                const st = statusOf({ acknowledged: Boolean(a.acknowledged), resolved: Boolean(a.resolved), emailed: Boolean(a.emailed), muted: Boolean(a.muted) });
                return (
                  <li key={i} className="rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
                    <div className="flex items-baseline justify-between gap-2">
                      <b>{label(a.metric as string)}</b>
                      <span className="shrink-0 text-xs text-zinc-500">{String(a.date)}</span>
                    </div>
                    {a.note ? <p className="mt-1 text-xs text-zinc-500">{String(a.note)}</p> : null}
                    <p className="mt-1">
                      {show(a.metric as string, a.value)}
                      <span className="text-zinc-500"> vs. usual {show(a.metric as string, a.baseline_median)}</span>
                    </p>
                    <p className={`mt-1 text-xs ${st.tone}`}>{st.word}</p>
                  </li>
                );
              })}
            </ul>
            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-zinc-300 text-xs text-zinc-500">
                    <th className="py-1">Started</th><th>Measurement</th><th>At the time</th><th>Usual</th><th>Severity</th><th>Since</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((a, i) => {
                    const st = statusOf({ acknowledged: Boolean(a.acknowledged), resolved: Boolean(a.resolved), emailed: Boolean(a.emailed), muted: Boolean(a.muted) });
                    return (
                      <tr key={i} className="border-b border-zinc-100 align-top dark:border-zinc-800">
                        <td className="py-1.5 whitespace-nowrap">{String(a.date)}</td>
                        <td>{label(a.metric as string)}{a.note ? <div className="text-xs text-zinc-500">{String(a.note)}</div> : null}</td>
                        <td>{show(a.metric as string, a.value)}</td>
                        <td>{show(a.metric as string, a.baseline_median)}</td>
                        <td>{String(a.severity)}</td>
                        <td className={st.tone}>{st.word}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <p className="text-xs text-zinc-500">
        Generated {today}. Deviations from {pet.name}&apos;s own usual ranges, measured by a
        consumer tracker — context for a veterinarian, not a diagnosis.
      </p>
    </main>
  );
}
