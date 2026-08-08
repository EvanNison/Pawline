import { readFileSync } from "fs";
import { fileURLToPath } from "url";

/**
 * Where the check scripts find a database to run against.
 *
 * The environment first, then this repo's own `.env.local`. Never anything
 * outside the repo: a script that reaches into a sibling directory works on
 * exactly one machine, and quietly reveals what else is on it.
 *
 * Any empty Postgres will do. Both checks build their schema in a throwaway
 * namespace and drop it afterwards.
 */
export function databaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const env = readFileSync(fileURLToPath(new URL("../.env.local", import.meta.url)), "utf8");
    const found = env.match(/^DATABASE_URL=(.+)$/m);
    if (found) return found[1].trim().replace(/^["']|["']$/g, "");
  } catch {
    // Falls through to the message below, which beats a bare ENOENT.
  }
  console.error(
    "No database to check against.\n" +
      "  Set DATABASE_URL, or put it in .env.local. Any empty Postgres works —\n" +
      "  this builds its schema in a throwaway namespace and drops it afterwards."
  );
  process.exit(2);
}
