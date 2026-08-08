"use client";

import { useActionState } from "react";
import Link from "next/link";
import { runImport, type ImportResult } from "./actions";

const field =
  "mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900";

/**
 * The upload form and its report.
 *
 * A client component so the result of the import can be shown in place. What
 * was *skipped* is as important as what was stored: a spreadsheet with a
 * shifted column imports plausible numbers into the wrong metrics, and the
 * warning list is the only place that becomes visible.
 */
export default function ImportForm({ labels }: { labels: Record<string, string> }) {
  const [result, action, pending] = useActionState<ImportResult | null, FormData>(runImport, null);

  return (
    <>
      <form action={action} className="space-y-4">
        <div>
          <label className="block text-sm font-medium" htmlFor="pet_name">
            Pet name{" "}
            <span className="font-normal text-zinc-500">
              (used only if the file has no pet column)
            </span>
          </label>
          <input id="pet_name" name="pet_name" placeholder="My pet" className={field} />
        </div>
        <div>
          <label className="block text-sm font-medium" htmlFor="file">
            Spreadsheet (.csv)
          </label>
          <input
            id="file"
            name="file"
            type="file"
            accept=".csv,text/csv"
            required
            className={field}
          />
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-60"
        >
          {pending ? "Importing…" : "Import"}
        </button>
      </form>

      {result && (
        <section className="space-y-3">
          {result.ok ? (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-100">
              ✅ Imported {result.written} reading{result.written === 1 ? "" : "s"} across{" "}
              {result.summary.days} day{result.summary.days === 1 ? "" : "s"}
              {result.summary.from && result.summary.to && (
                <> ({result.summary.from} to {result.summary.to})</>
              )}
              . <Link href="/" className="underline">See the dashboard</Link>.
              {result.summary.warnings.length > 0 && (
                <p className="mt-1">Some rows were skipped — see below.</p>
              )}
            </div>
          ) : (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900 dark:bg-red-950 dark:text-red-100">
              ❌ Nothing was imported — {result.error}
            </div>
          )}

          {result.summary && result.summary.byMetric.length > 0 && (
            <div className="rounded-xl border border-zinc-200 p-3 text-sm dark:border-zinc-800">
              <h3 className="font-medium">
                What was found{result.ok ? "" : " (not stored)"}
              </h3>
              <ul className="mt-1 text-zinc-600 dark:text-zinc-400">
                {result.summary.byMetric.map((m) => (
                  <li key={m.metric}>
                    {labels[m.metric] ?? m.metric}: {m.count}
                  </li>
                ))}
              </ul>
              {result.summary.pets.length > 1 && (
                <p className="mt-2 text-zinc-600 dark:text-zinc-400">
                  Pets: {result.summary.pets.join(", ")}
                </p>
              )}
            </div>
          )}

          {result.summary && result.summary.warnings.length > 0 && (
            <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
              <h3 className="font-medium">Skipped, and why</h3>
              <ul className="mt-1 space-y-0.5">
                {result.summary.warnings.map((w, i) => (
                  <li key={i}>
                    Row {w.row}: {w.message}
                  </li>
                ))}
              </ul>
              {result.summary.hiddenWarnings > 0 && (
                <p className="mt-2 font-medium">
                  …and {result.summary.hiddenWarnings} more not listed.
                </p>
              )}
            </div>
          )}
        </section>
      )}
    </>
  );
}
