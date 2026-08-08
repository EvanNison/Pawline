import { readFileSync } from "fs";
import { fileURLToPath } from "url";

/**
 * Where the check scripts find a database to run against.
 *
 * The environment first, then this repo's own `.env.local`. Never anything
 * outside the repo: a script that reaches into a sibling directory works on
 * exactly one machine, and quietly reveals what else is on it.
 *
 * Any empty Postgres *that accepts TLS* will do — the app connects with
 * `ssl: "require"`, so a plain local server without SSL will not work. A free
 * Neon database is the easy answer. Both checks build their schema in a
 * throwaway namespace and drop it afterwards.
 */
export function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const env = readFileSync(fileURLToPath(new URL("../.env.local", import.meta.url)), "utf8");
    const found = env.match(/^DATABASE_URL=(.*)$/m);
    // A present-but-empty line is the same as no line, and must fall through to
    // the message below. `vercel env pull` writes `DATABASE_URL=""` for a
    // variable marked sensitive, and returning that empty string sent the
    // driver to its default host — so the real problem ("the URL you pulled has
    // no value in it") arrived as `ECONNREFUSED 127.0.0.1:5432`, which sends
    // you looking for a local Postgres you were never meant to be running.
    const url = found ? found[1].trim().replace(/^["']|["']$/g, "") : "";
    if (url) return url;
  } catch {
    // Falls through to the message below, which beats a bare ENOENT.
  }
  console.error(
    "No database to check against.\n" +
      "  Set DATABASE_URL, or put it in .env.local. Any empty Postgres that\n" +
      "  accepts TLS works — this builds its schema in a throwaway namespace\n" +
      "  and drops it afterwards."
  );
  process.exit(2);
}
