import { redirect } from "next/navigation";
import Link from "next/link";
import NotConfigured from "@/components/NotConfigured";
import { ensureSchema, sql } from "@/lib/db";
import { readSettings, writeSetting } from "@/lib/settings";
import { protect } from "@/lib/secrets";
import { acknowledgementFor, recordAcknowledgement, setEnabled, TRACTIVE_SOURCE_INFO } from "@/lib/sources/registry";
import { isValidTimezone } from "@/lib/time";

export const dynamic = "force-dynamic";

async function saveBasics(formData: FormData) {
  "use server";
  await ensureSchema();
  const units = String(formData.get("units") || "metric");
  const tz = String(formData.get("timezone") || "").trim();
  const species = String(formData.get("species") || "unknown");
  const email = String(formData.get("alert_email") || "").trim();
  const gmailUser = String(formData.get("gmail_user") || "").trim();
  // Google shows app passwords in groups of four and people paste them so;
  // the spaces are presentation, not part of the secret.
  const gmailPass = String(formData.get("gmail_app_password") || "").replace(/\s+/g, "");

  await writeSetting("units", units === "imperial" ? "imperial" : "metric");
  await writeSetting("species", species);
  if (tz && isValidTimezone(tz)) await writeSetting("timezone", tz);
  if (email) await writeSetting("alert_email", email);
  if (gmailUser) await writeSetting("gmail_user", gmailUser);
  if (gmailPass) await writeSetting("gmail_app_password", await protect(gmailPass));
  redirect("/setup?status=saved");
}

async function enableTractive(formData: FormData) {
  "use server";
  await ensureSchema();
  const email = String(formData.get("tractive_email") || "").trim();
  const password = String(formData.get("tractive_password") || "");
  const accepted = formData.get("accept") === "on";

  // The gate. Without an explicit acceptance there is no acknowledgement row,
  // and without that row the source cannot run however the flag is set.
  if (!accepted) redirect("/setup?status=not_accepted");
  if (!email || !password) redirect("/setup?status=missing_login");

  await sql()`insert into app_config (key, value) values ('source:tractive:credentials',
      ${await protect(JSON.stringify({ email, password }))})
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
  await recordAcknowledgement("tractive");
  await setEnabled("tractive", true);
  redirect("/setup?status=tractive_on");
}

const MESSAGES: Record<string, { ok: boolean; text: string }> = {
  saved: { ok: true, text: "✅ Saved." },
  tractive_on: { ok: true, text: "✅ Tractive connected. Collection runs daily from now on." },
  not_accepted: { ok: false, text: "❌ Not enabled — the acknowledgement was not ticked." },
  missing_login: { ok: false, text: "❌ Please enter both the email and password." },
};

export default async function SetupPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  if (!process.env.DATABASE_URL && !process.env.POSTGRES_URL) return <NotConfigured />;
  try {
    await ensureSchema();
  } catch (e) {
    // Reachability, not emptiness. A database that cannot be reached must say
    // so rather than rendering as "no data yet", which reads as "your pet has
    // no readings" — a false statement about the pet rather than the app.
    return <NotConfigured detail={String(e).slice(0, 160)} />;
  }
  const settings = await readSettings();
  const ack = await acknowledgementFor("tractive");
  const msg = status ? MESSAGES[status] : null;

  const field = "mt-1 w-full rounded-md border border-zinc-300 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900";

  return (
    <main className="mx-auto max-w-2xl space-y-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold sm:text-2xl">⚙️ Setup</h1>
        <Link href="/" className="rounded-md bg-zinc-100 px-2 py-1 text-sm dark:bg-zinc-800">← Dashboard</Link>
      </header>

      {msg && (
        <p className={`rounded-lg border p-3 text-sm ${msg.ok ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-red-200 bg-red-50 text-red-900"}`}>
          {msg.text}
        </p>
      )}

      <form action={saveBasics} className="space-y-4 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
        <h2 className="font-semibold">Basics</h2>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label className="block text-sm font-medium" htmlFor="units">Units</label>
            <select id="units" name="units" defaultValue={settings.units} className={field}>
              <option value="metric">Metric (kg, km)</option>
              <option value="imperial">Imperial (lb, miles)</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium" htmlFor="species">Species</label>
            <select id="species" name="species" defaultValue={settings.species} className={field}>
              <option value="unknown">Not specified</option>
              <option value="dog">Dog</option>
              <option value="cat">Cat</option>
            </select>
          </div>
        </div>
        <div>
          <label className="block text-sm font-medium" htmlFor="timezone">Your pet&apos;s timezone</label>
          <input id="timezone" name="timezone" defaultValue={settings.timezone} placeholder="Europe/London" className={field} />
          <p className="mt-1 text-xs text-zinc-500">
            Decides which day each reading belongs to. Set it once and leave it — changing it
            later re-partitions history that is already stored.
          </p>
        </div>
        <div>
          <label className="block text-sm font-medium" htmlFor="alert_email">Send alerts to</label>
          <input id="alert_email" name="alert_email" type="email" defaultValue={settings.alertEmail ?? ""} className={field} />
        </div>
        <fieldset className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <legend className="px-1 text-sm font-medium">Sending via Gmail</legend>
          <p className="text-xs text-zinc-500">
            You are emailing yourself, so your own mailbox is the simplest route. Needs a Google{" "}
            <a className="underline" href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">App Password</a>,
            not your normal password — it only permits sending mail and can be revoked any time.
          </p>
          <input name="gmail_user" type="email" placeholder="you@gmail.com" className={field} />
          <input name="gmail_app_password" type="password" autoComplete="off" placeholder="app password" className={field} />
        </fieldset>
        <button type="submit" className="rounded-md bg-indigo-600 px-4 py-2 font-medium text-white">Save</button>
      </form>

      <form action={enableTractive} className="space-y-4 rounded-xl border border-amber-300 p-4 dark:border-amber-800">
        <h2 className="font-semibold">Connect a Tractive account</h2>
        {ack && (
          <p className="text-xs text-emerald-700 dark:text-emerald-300">
            Acknowledged {new Date(ack.acceptedAt).toLocaleDateString()} — connected.
          </p>
        )}
        <div className="whitespace-pre-line rounded-lg bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          {TRACTIVE_SOURCE_INFO.advisory}
        </div>
        <div>
          <label className="block text-sm font-medium" htmlFor="tractive_email">Tractive email</label>
          <input id="tractive_email" name="tractive_email" type="email" className={field} />
        </div>
        <div>
          <label className="block text-sm font-medium" htmlFor="tractive_password">Tractive password</label>
          <input id="tractive_password" name="tractive_password" type="password" autoComplete="off" className={field} />
          <p className="mt-1 text-xs text-zinc-500">Stored encrypted. Never shown again.</p>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" name="accept" className="mt-1" />
          <span>
            I have read the above and accept that using this may end my Tractive subscription
            without refund.
          </span>
        </label>
        <button type="submit" className="rounded-md bg-amber-600 px-4 py-2 font-medium text-white">
          Enable Tractive collection
        </button>
      </form>
    </main>
  );
}
