import Link from "next/link";

/**
 * Shown when the database is not reachable yet.
 *
 * A fresh deploy whose database has not finished linking would otherwise show
 * a raw 500 on every page — a dead end for the non-technical person the setup
 * guide is written for, and the point at which an assistant helping them starts
 * inventing explanations.
 */
export default function NotConfigured({ detail }: { detail?: string }) {
  return (
    <main className="mx-auto max-w-2xl space-y-4 p-4 sm:p-6">
      <h1 className="text-xl font-bold sm:text-2xl">🐾 Pawline</h1>
      <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
        <p className="font-medium">The database isn&apos;t connected yet.</p>
        <p className="mt-2">
          This is the expected next step after deploying, not a fault. Add one from the
          Vercel dashboard: <strong>Storage → Create Database → Neon</strong> (the free plan
          is enough), and connect it to this project. Vercel then sets{" "}
          <code>DATABASE_URL</code> for you.
        </p>
        <p className="mt-2">
          Redeploy afterwards, from <strong>Deployments → ⋯ → Redeploy</strong>, so the new
          setting is picked up. If you have just done that, wait a minute and reload.
        </p>
        {detail && <p className="mt-2 text-xs opacity-75">Reported: {detail}</p>}
      </div>
      <p className="text-xs text-zinc-500">
        Nothing has been lost — this page cannot reach storage, which is different from
        storage being empty.
      </p>
      <Link href="/" className="inline-block text-sm underline">Try again</Link>
    </main>
  );
}
