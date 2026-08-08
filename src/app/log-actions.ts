"use server";

import { revalidatePath } from "next/cache";
import { requireSession } from "@/lib/session";
import { ensureSchema, sql } from "@/lib/db";
import { readSettings } from "@/lib/settings";
import { addCapability, writeReadings } from "@/lib/store";
import { toCanonical } from "@/lib/units";
import { localDate } from "@/lib/time";

export type LogResult = { ok: boolean; message: string } | null;

/**
 * Today's date in the pet's own timezone, or null if there is no such pet.
 *
 * The pet id arrives from a hidden form field, so it can be stale — the pet
 * deleted, or the page open since before a reset. Destructuring the row
 * directly turned that into "Cannot destructure property 'timezone' of
 * undefined", a 500 where a sentence belongs.
 */
async function dateForPet(petId: string, fallbackTz: string): Promise<string | null> {
  const [row] = await sql()`select timezone from pets where id = ${petId}`;
  if (!row) return null;
  return localDate(String(row.timezone ?? fallbackTz));
}

/**
 * Log a weight by hand.
 *
 * Weight is the measurement vets ask about most and the one almost no collar
 * reports, so without this it is the single biggest hole in the record. Entered
 * in whatever units the app is set to and stored canonically, like every other
 * reading — the conversion happens here so the chart and the vet report cannot
 * disagree about what the number meant.
 */
export async function logWeight(_prev: LogResult, formData: FormData): Promise<LogResult> {
  await requireSession();

  const petId = String(formData.get("pet_id") || "");
  const raw = String(formData.get("weight") || "").trim();
  if (!petId) return { ok: false, message: "No pet selected." };
  if (raw === "") return { ok: false, message: "Enter a weight first." };

  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return { ok: false, message: `"${raw}" is not a weight.` };
  }

  await ensureSchema();
  const settings = await readSettings();
  const date = await dateForPet(petId, settings.timezone);
  if (date === null) return { ok: false, message: "That pet no longer exists — reload the page." };

  await writeReadings(petId, "manual", [
    { petKey: petId, date, metric: "weight", value: toCanonical(n, "mass", settings.units) },
  ]);
  // Without this the dashboard filters weight straight back out, because
  // capabilities are declared by source adapters and a hand-logged reading has
  // no adapter to declare it. Stored, correct, and invisible.
  await addCapability(petId, "weight");

  revalidatePath("/");
  const unit = settings.units === "imperial" ? "lb" : "kg";
  return { ok: true, message: `Logged ${n} ${unit} for ${date}.` };
}

/**
 * Add a dated note.
 *
 * The thing that makes a chart interpretable a year later. "Activity dropped in
 * March" is a mystery; "activity dropped in March, and here is a note saying the
 * new medication started on the 4th" is an answer.
 */
export async function logNote(_prev: LogResult, formData: FormData): Promise<LogResult> {
  await requireSession();

  const petId = String(formData.get("pet_id") || "");
  const note = String(formData.get("note") || "").trim();
  const category = String(formData.get("category") || "note");
  if (!petId) return { ok: false, message: "No pet selected." };
  if (note === "") return { ok: false, message: "Write something first." };

  await ensureSchema();
  const settings = await readSettings();
  const date = await dateForPet(petId, settings.timezone);
  if (date === null) return { ok: false, message: "That pet no longer exists — reload the page." };

  await sql()`insert into journal (pet_id, date, category, note)
    values (${petId}, ${date}, ${category}, ${note.slice(0, 2000)})`;

  revalidatePath("/");
  return { ok: true, message: `Noted for ${date}.` };
}
