"use server";

import { requireSession } from "@/lib/session";
import { ensureSchema } from "@/lib/db";
import { readSettings } from "@/lib/settings";
import { upsertPet, writeReadingsBulk } from "@/lib/store";
import { CsvSource, parseCsv, summarizeImport, type ImportSummary } from "@/lib/sources/csv";

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

  const settings = await readSettings();
  const defaultName = String(formData.get("pet_name") || "").trim() || "My pet";
  const parsed = parseCsv(text, defaultName);
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
    await ensureSchema();
    const source = new CsvSource(text, {
      species: settings.species,
      timezone: settings.timezone,
      defaultPetName: defaultName,
    });

    let written = 0;
    for (const pet of await source.listPets()) {
      const petId = await upsertPet("csv", pet, settings.timezone);
      written += await writeReadingsBulk(
        petId,
        "csv",
        parsed.readings.filter((r) => r.petKey === pet.key)
      );
    }
    return { ok: true, summary, written };
  } catch (e) {
    // Surfaced rather than thrown: a failed import must say so on the page, not
    // become a generic error screen the reader cannot act on.
    return { ok: false, error: `could not be saved — ${String(e).slice(0, 200)}`, summary };
  }
}
