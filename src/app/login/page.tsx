import { redirect } from "next/navigation";
import { authState } from "@/lib/auth";
import { isSignedIn, startSession } from "@/lib/session";

export const dynamic = "force-dynamic";

async function signIn(formData: FormData) {
  "use server";
  const ok = await startSession(String(formData.get("password") || ""));
  redirect(ok ? "/" : "/login?status=wrong");
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  if (await isSignedIn()) redirect("/");

  // No password set in production. Saying so plainly beats a wrong-password
  // loop that looks like a forgotten password and is actually a missing
  // deployment setting — the person would never guess, and would keep trying.
  if (authState().mode === "misconfigured") {
    return (
      <main className="mx-auto max-w-lg space-y-4 p-6">
        <h1 className="text-lg font-semibold">This site is not protected yet</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          No <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">APP_PASSWORD</code> is set,
          so Pawline is refusing to show your pet&rsquo;s data rather than serving it to anyone with
          the link.
        </p>
        <ol className="list-decimal space-y-1 pl-5 text-sm text-zinc-600 dark:text-zinc-400">
          <li>Open your project on Vercel, then Settings → Environment Variables.</li>
          <li>
            Add <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">APP_PASSWORD</code> with
            a long password of your choosing.
          </li>
          <li>Redeploy. This page will then ask for that password.</li>
        </ol>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-sm space-y-4 p-6">
      <h1 className="text-lg font-semibold">🐾 Pawline</h1>
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Enter your dashboard password.
      </p>
      <form action={signIn} className="space-y-3">
        <input
          type="password"
          name="password"
          autoFocus
          autoComplete="current-password"
          aria-label="Dashboard password"
          className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        {status === "wrong" && (
          <p className="text-sm text-red-600 dark:text-red-400">
            That password did not match. It is the one you set as APP_PASSWORD when you deployed —
            not your Tractive password.
          </p>
        )}
        <button
          type="submit"
          className="w-full rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500"
        >
          Sign in
        </button>
      </form>
    </main>
  );
}
