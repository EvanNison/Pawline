import { ensureSchema, sql, schemaState } from "@/lib/db";
import { readSettings } from "@/lib/settings";
import { localDate } from "@/lib/time";
import { REGISTRY, metric as metricDef } from "@/lib/metrics";
import { buildStatus, headline, overallLevel, type Check, type Level } from "@/lib/health";
import { emailChannel } from "@/lib/notify";
import { encryptionKey } from "@/lib/secrets";
import Link from "next/link";

export const dynamic = "force-dynamic";

const TONE: Record<Level, { dot: string; box: string; word: string }> = {
  ok: {
    dot: "bg-emerald-500",
    box: "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100",
    word: "Working",
  },
  warn: {
    dot: "bg-amber-500",
    box: "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100",
    word: "Worth a look",
  },
  bad: {
    dot: "bg-red-500",
    box: "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100",
    word: "Broken",
  },
  unknown: {
    dot: "bg-zinc-400",
    box: "border-zinc-300 bg-zinc-50 text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200",
    word: "Not known",
  },
};

export default async function StatusPage() {
  await ensureSchema();
  const s = sql();
  const settings = await readSettings();
  const today = localDate(settings.timezone);

  const [lastRunRow] = await s`select started_at, finished_at, ok, error
    from runs order by started_at desc limit 1`;
  const [lastOkRow] = await s`select finished_at from runs
    where ok = true order by started_at desc limit 1`;
  const [{ count: petCount }] = await s`select count(*)::int as count from pets`;
  const [creds] = await s`select value from app_config where key = 'source:tractive:credentials'`;
  const [{ count: undelivered }] = await s`select count(*)::int as count from alerts
    where emailed = false and acknowledged = false and abandoned = false and muted = false`;
  // Ask the notify layer itself rather than re-deriving the rule here: two
  // copies of "is email set up" would drift, and this page exists to be trusted.
  const channel = await emailChannel();
  const emailConfigured = channel !== "none";

  const freshRows = await s`select metric, max(date)::text as newest
    from daily_metrics where metric not like 'raw.%' group by metric`;
  const freshByMetric = new Map(freshRows.map((r) => [r.metric as string, r.newest as string | null]));

  const checks = buildStatus({
    now: new Date(),
    today,
    lastRun: lastRunRow
      ? {
          startedAt: new Date(String(lastRunRow.started_at)).toISOString(),
          finishedAt: lastRunRow.finished_at ? new Date(String(lastRunRow.finished_at)).toISOString() : null,
          ok: lastRunRow.ok === null ? null : Boolean(lastRunRow.ok),
          error: (lastRunRow.error as string | null) ?? null,
        }
      : null,
    lastSuccessAt: lastOkRow?.finished_at ? new Date(String(lastOkRow.finished_at)).toISOString() : null,
    metricFreshness: REGISTRY.filter((d) => d.alert).map((d) => ({
      metric: d.key,
      label: metricDef(d.key)?.label ?? d.key,
      newest: freshByMetric.get(d.key) ?? null,
    })),
    emailConfigured,
    undeliveredAlerts: Number(undelivered),
    credentialsPresent: Boolean(creds),
    petCount: Number(petCount),
  });

  // Name the route, so "email is on" is checkable rather than taken on faith.
  const emailCheck = checks.find((c) => c.id === "email");
  if (emailCheck && channel !== "none") {
    emailCheck.detail = `Sending via ${channel === "gmail" ? "your Gmail account" : "Resend"}. ${emailCheck.detail}`;
  }

  // Credential protection and schema state: reported, not assumed. "Still
  // plaintext" and "migrations behind" are both states nobody notices.
  const keySet = Boolean(encryptionKey());
  const storedEncrypted = creds ? String(creds.value).startsWith("enc:") : false;
  const schema = await schemaState();
  checks.splice(
    checks.findIndex((c) => c.id === "credentials") + 1,
    0,
    !creds
      ? { id: "encryption", label: "Stored password protection", level: "unknown", detail: "Nothing stored yet." }
      : storedEncrypted
        ? { id: "encryption", label: "Stored password protection", level: "ok", detail: "Saved credentials are encrypted." }
        : keySet
          ? { id: "encryption", label: "Stored password protection", level: "warn", detail: "Encryption is configured but this credential predates it; it will be upgraded on the next collection." }
          : { id: "encryption", label: "Stored password protection", level: "warn", detail: "Credentials are stored in plain text. Set an ENCRYPTION_KEY to protect them." },
    schema.current === schema.expected
      ? { id: "schema", label: "Database", level: "ok", detail: `Up to date (version ${schema.current}).` }
      : { id: "schema", label: "Database", level: "bad", detail: `Migrations are behind: at version ${schema.current}, expected ${schema.expected}. Data may not save correctly.` }
  );

  const level = overallLevel(checks);
  const recent = await s`select started_at, finished_at, ok, trigger, days_written, error
    from runs order by started_at desc limit 10`;

  const group = (ids: (c: Check) => boolean) => checks.filter(ids);
  const system = group((c) => !c.id.startsWith("metric:"));
  const metrics = group((c) => c.id.startsWith("metric:"));

  return (
    <main className="mx-auto max-w-3xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold sm:text-2xl">🩹 Is this working?</h1>
        <nav className="flex gap-2 text-sm">
          <Link href="/" className="rounded-md bg-zinc-100 px-2 py-1 dark:bg-zinc-800">← Dashboard</Link>
          <Link href="/alerts" className="rounded-md bg-zinc-100 px-2 py-1 dark:bg-zinc-800">🔔 Alerts</Link>
          <Link href="/setup" className="rounded-md bg-zinc-100 px-2 py-1 dark:bg-zinc-800">⚙️ Setup</Link>
        </nav>
      </header>

      <section className={`rounded-xl border p-4 ${TONE[level].box}`}>
        <div className="flex items-center gap-2 text-lg font-semibold">
          <span className={`inline-block h-3 w-3 rounded-full ${TONE[level].dot}`} />
          {headline(level)}
        </div>
        <p className="mt-1 text-sm opacity-80">
          This page checks whether data is still arriving. It says nothing about your
          pet&apos;s health — that is the dashboard&apos;s job.
        </p>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-zinc-500">The system</h2>
        {system.map((c) => (
          <div key={c.id} className={`rounded-lg border p-3 text-sm ${TONE[c.level].box}`}>
            <div className="flex items-center gap-2 font-medium">
              <span className={`inline-block h-2 w-2 rounded-full ${TONE[c.level].dot}`} />
              {c.label}
              <span className="ml-auto text-[10px] uppercase tracking-wide opacity-70">{TONE[c.level].word}</span>
            </div>
            <p className="mt-1 opacity-90">{c.detail}</p>
          </div>
        ))}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold text-zinc-500">
          Each measurement — a metric can stop arriving while collection still succeeds
        </h2>
        <div className="grid gap-2 sm:grid-cols-2">
          {metrics.map((c) => (
            <div key={c.id} className={`rounded-lg border p-3 text-sm ${TONE[c.level].box}`}>
              <div className="flex items-center gap-2 font-medium">
                <span className={`inline-block h-2 w-2 rounded-full ${TONE[c.level].dot}`} />
                {c.label}
              </div>
              <p className="mt-1 text-xs opacity-90">{c.detail}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-semibold text-zinc-500">Recent collection attempts</h2>
        {recent.length === 0 ? (
          <p className="text-sm text-zinc-500">
            No attempts recorded yet. This table starts filling from the next run.
          </p>
        ) : (
          <>
            <ul className="space-y-2 sm:hidden">
              {recent.map((r, i) => (
                <li key={i} className="rounded-lg border border-zinc-200 p-3 text-sm dark:border-zinc-800">
                  <div className="flex items-baseline justify-between gap-2">
                    <b>
                      {r.finished_at === null ? "never finished" : r.ok ? "ok" : "failed"}
                    </b>
                    <span className="shrink-0 text-xs text-zinc-500">
                      {new Date(String(r.started_at)).toLocaleString()}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-zinc-500">
                    {String(r.trigger)} · {String(r.days_written)} day
                    {Number(r.days_written) === 1 ? "" : "s"} written
                  </p>
                  {r.error ? <p className="mt-1 text-xs">{String(r.error).slice(0, 160)}</p> : null}
                </li>
              ))}
            </ul>

            <div className="hidden overflow-x-auto sm:block">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-zinc-300 text-xs text-zinc-500">
                    <th className="py-1">Started</th>
                    <th>Result</th>
                    <th>Trigger</th>
                    <th>Days written</th>
                  </tr>
                </thead>
                <tbody>
                  {recent.map((r, i) => (
                    <tr key={i} className="border-b border-zinc-100 dark:border-zinc-800">
                      <td className="py-1.5">{new Date(String(r.started_at)).toLocaleString()}</td>
                      <td>
                        {r.finished_at === null
                          ? "never finished"
                          : r.ok
                            ? "ok"
                            : `failed — ${String(r.error ?? "unknown").slice(0, 80)}`}
                      </td>
                      <td>{String(r.trigger)}</td>
                      <td>{String(r.days_written)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      <p className="text-xs text-zinc-500">
        Safe to share when asking for help — it contains no passwords, keys or
        connection details. Never paste those anywhere.
      </p>
    </main>
  );
}
