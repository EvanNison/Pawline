"use server";

import { requireSession } from "@/lib/session";
import { ensureSchema } from "@/lib/db";
import { readSettings } from "@/lib/settings";
import { upsertPet, writeReadingsBulk } from "@/lib/store";
import { CsvSource, parseCsv, summarizeImport, type ImportSummary } from "@/lib/sources/csv";
import { raiseAndWithdrawAlerts } from "@/lib/alert-run";
import { localDate } from "@/lib/time";

/** A decade of daily readings across every metric is well under a megabyte. */
const MAX_BYTES = 8 * 1024 * 1024;

export type ImportResult =
  | { ok: true; summary: ImportSummary; written: number }
  | { ok: false; error: string; summary: ImportSummary | null };

/**
 * Parse an uploaded spreadsheet and store what it contains.
 *
 * Imports are written under the `csv` source id, so an imported pet is a
 * distinct pet from a collected one and cannot overwrite history from a
 * connected tracker. Re-uploading a corrected file replaces the same days
 * rather than duplicating them.
 */
export async function runImport(
  _prev: ImportResult | null,
  formData: FormData
): Promise<ImportResult> {
  // First statement, as in every action here: Next routes Server Actions by
  // action id rather than by path, so the proxy does not protect them.
  await requireSession();

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false, error: "Choose a .csv file first.", summary: null };
  }
  // Checked before reading it into memory. Picking the wrong file by accident is
  // far likelier than a genuinely enormous one.
  if (file.size > MAX_BYTES) {
    return {
      ok: false,
      error: `That file is ${(file.size / 1024 / 1024).toFixed(1)} MB, which is far larger than daily readings should be. Is it the right file?`,
      summary: null,
    };
  }

  let text: string;
  try {
    text = await file.text();
  } catch {
    return { ok: false, error: "That file could not be read as text.", summary: null };
  }

  // Before the first read, not just before the writes. On a fresh deployment no
  // tables exist yet, and the setup guide now sends people here first — so
  // reading settings ahead of this made importing a spreadsheet, the very first
  // thing a new user is told to do, fail with "relation app_config does not
  // exist".
  await ensureSchema();

  const settings = await readSettings();
  const defaultName = String(formData.get("pet_name") || "").trim() || "My pet";
  // Today in the pet's own zone, so "the future" means the future where the
  // animal actually lives rather than in UTC.
  const today = localDate(settings.timezone);
  const parsed = parseCsv(text, defaultName, { today });
  const summary = summarizeImport(parsed);

  // Reported before anything is written. "Nothing was recognised" and "it
  // worked" must not look alike, and the warnings are the only account of what
  // was dropped on the way.
  if (parsed.readings.length === 0) {
    return {
      ok: false,
      error: parsed.warnings[0]?.message ?? "no readings were found in that file",
      summary,
    };
  }

  try {
    const source = new CsvSource(text, {
      species: settings.species,
      timezone: settings.timezone,
      defaultPetName: defaultName,
      today,
    });

    // Grouped once rather than filtered per pet: a file with a stray pet column
    // can name thousands of distinct "pets", and a filter inside the loop makes
    // that a full pass over every reading for each one.
    const byPet = new Map<string, typeof parsed.readings>();
    for (const r of parsed.readings) {
      const list = byPet.get(r.petKey);
      if (list) list.push(r);
      else byPet.set(r.petKey, [r]);
    }

    let written = 0;
    const petIds: string[] = [];
    for (const pet of await source.listPets()) {
      const petId = await upsertPet("csv", pet, settings.timezone);
      petIds.push(petId);
      written += await writeReadingsBulk(petId, "csv", byPet.get(pet.key) ?? []);
    }

    // Judge the data now rather than at the next scheduled run. Someone
    // importing two years of history expects to see what it says, and waiting
    // overnight for a cron they may not have configured reads as the alerting
    // simply not working. Failures here do not fail the import: the readings
    // are stored, and the nightly run evaluates them again.
    for (const petId of petIds) {
      await raiseAndWithdrawAlerts(petId, today, settings.mutedMetrics).catch(
        (e) => console.error("[import] alert evaluation skipped:", String(e).slice(0, 200))
      );
    }
    return { ok: true, summary, written };
  } catch (e) {
    // Surfaced rather than thrown: a failed import must say so on the page, not
    // become a generic error screen the reader cannot act on.
    // Deliberately not "nothing was imported": bulk writes commit per chunk, so
    // some rows may already be stored. Saying otherwise would send someone
    // looking for data that is there, or leave them believing a half-import is
    // clean. Re-uploading the same file is safe and is the fix.
    return {
      ok: false,
      error: `stopped partway — ${String(e).slice(0, 160)}. Some rows may already be saved; re-uploading the same file is safe and will finish the job.`,
      summary,
    };
  }
}
