import Link from "next/link";
import { requireSession } from "@/lib/session";
import NotConfigured from "@/components/NotConfigured";
import { REGISTRY } from "@/lib/metrics";
import ImportForm from "./ImportForm";

export const dynamic = "force-dynamic";

/**
 * Import a spreadsheet.
 *
 * The vendor-free way in, and what makes "works with any tracker" true rather
 * than merely intended. It is also why the export format matters: whatever put
 * data here can take it out again.
 */
export default async function ImportPage() {
  await requireSession();
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) return <NotConfigured />;

  // Labels resolved on the server so the client bundle does not carry the
  // registry, and so the column list below stays in step with what the app
  // actually accepts rather than being a hand-written copy that drifts.
  const labels = Object.fromEntries(REGISTRY.map((d) => [d.key, d.label]));

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold sm:text-2xl">📄 Import a spreadsheet</h1>
        <nav className="flex flex-wrap gap-1.5 text-sm">
          <Link href="/" className="rounded-md bg-zinc-100 px-2 py-1 dark:bg-zinc-800">← Dashboard</Link>
          <Link href="/setup" className="rounded-md bg-zinc-100 px-2 py-1 dark:bg-zinc-800">⚙️ Setup</Link>
        </nav>
      </header>

      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Any tracker that exports a spreadsheet works here, as does one you keep by hand.
        No account, no credentials, nothing to accept.
      </p>

      <section className="rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-800">
        <h2 className="font-semibold">What the file should look like</h2>
        <p className="mt-1 text-zinc-600 dark:text-zinc-400">
          One row per day: a <code>date</code> column in YYYY-MM-DD, then one column per
          measurement.
        </p>
        <pre className="mt-2 overflow-x-auto rounded-lg bg-zinc-50 p-3 text-xs dark:bg-zinc-900">
{`date,resting_heart_rate,night_sleep_minutes,weight_lb
2026-08-01,62,481,32.0
2026-08-02,63,455,`}
        </pre>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-zinc-600 dark:text-zinc-400">
          <li>
            <b>Units go in the header, never guessed.</b> <code>weight_lb</code> and{" "}
            <code>weight_kg</code> are both converted. Guessing could mis-scale a chart a
            vet reads.
          </li>
          <li>
            <b>A blank cell means &ldquo;not measured&rdquo;</b>, which is not the same as zero.
          </li>
          <li>Add a <code>pet</code> column if the file covers more than one animal.</li>
          <li>
            Re-uploading a corrected file replaces those same days rather than duplicating
            them.
          </li>
          <li>Columns that aren&rsquo;t recognised are skipped and listed, never guessed at.</li>
        </ul>
      </section>

      <ImportForm labels={labels} />

      <details className="rounded-xl border border-zinc-200 p-4 text-sm dark:border-zinc-800">
        <summary className="cursor-pointer font-semibold">Column names it recognises</summary>
        <ul className="mt-2 grid grid-cols-1 gap-x-4 gap-y-0.5 text-zinc-600 sm:grid-cols-2 dark:text-zinc-400">
          {REGISTRY.map((d) => (
            <li key={d.key}>
              <code>{d.key}</code> — {d.label}
            </li>
          ))}
        </ul>
      </details>

      <p className="text-xs text-zinc-500">
        Imported data is stored separately from anything collected automatically, so this
        cannot overwrite history from a connected tracker.
      </p>
    </main>
  );
}
