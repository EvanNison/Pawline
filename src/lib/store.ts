/**
 * Database reads and writes.
 *
 * Thin on purpose: every decision worth arguing about lives in a pure module
 * that can be tested without a database. This file moves rows.
 */

import { sql } from "./db";
import type { DayPoint } from "./baseline";
import type { StoredDay } from "./collector";
import type { Reading, SourcePet } from "./sources/types";
import { isKnownMetric } from "./metrics";

export interface Pet {
  id: string;
  sourceId: string;
  sourceKey: string;
  name: string;
  species: string;
  timezone: string;
  capabilities: string[];
}

/**
 * Read a jsonb array column back as an actual array.
 *
 * This driver hands `jsonb` back as a **string**, so `r.capabilities as string[]`
 * was a compile-time cast over a runtime lie. Everything downstream then did
 * `new Set(capabilities)` on a string, producing a set of single characters, so
 * `cap.has("resting_heart_rate")` was always false — and every dashboard showed
 * a pet name, "not enough history", and no charts at all, from any source.
 *
 * Invisible to the unit suite, which hands back genuine arrays from a fake
 * runner. Accepts both shapes so a driver or config that does parse jsonb keeps
 * working.
 */
export function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export async function listPets(): Promise<Pet[]> {
  const rows = await sql()`select id, source_id, source_key, name, species, timezone, capabilities
    from pets order by name`;
  return rows.map((r) => ({
    id: r.id as string,
    sourceId: r.source_id as string,
    sourceKey: r.source_key as string,
    name: r.name as string,
    species: r.species as string,
    timezone: r.timezone as string,
    capabilities: toStringArray(r.capabilities),
  }));
}

export async function upsertPet(sourceId: string, pet: SourcePet, timezone: string): Promise<string> {
  const id = `${sourceId}:${pet.key}`;
  await sql()`insert into pets (id, source_id, source_key, name, species, timezone, capabilities, updated_at)
    values (${id}, ${sourceId}, ${pet.key}, ${pet.name}, ${pet.species},
            ${pet.timezone ?? timezone}, ${JSON.stringify(pet.capabilities)}::jsonb, now())
    on conflict (source_id, source_key) do update set
      name = excluded.name, species = excluded.species,
      capabilities = excluded.capabilities, updated_at = now()`;
  return id;
}

/**
 * Store readings.
 *
 * Anything naming a metric the registry does not know is rejected rather than
 * stored. An adapter emitting an unrecognised key is a bug in the adapter, and
 * silently accepting it would put a value on a chart with no declared unit.
 */
export async function writeReadings(petId: string, sourceId: string, readings: Reading[]): Promise<number> {
  let written = 0;
  for (const r of readings) {
    if (!isKnownMetric(r.metric)) {
      console.error(`[store] refusing unknown metric "${r.metric}" from ${sourceId}`);
      continue;
    }
    if (!Number.isFinite(r.value)) continue;
    await sql()`insert into daily_metrics (pet_id, date, metric, value, source_id, updated_at)
      values (${petId}, ${r.date}, ${r.metric}, ${r.value}, ${sourceId}, now())
      on conflict (pet_id, date, metric) do update set
        value = excluded.value, source_id = excluded.source_id, updated_at = now()`;
    written++;
  }
  return written;
}

/**
 * Store many readings at once, for imports.
 *
 * Separate from writeReadings because the shapes differ by three orders of
 * magnitude: a collection writes a handful of rows for one day, while an import
 * of two years across six metrics is several thousand. One round trip each is
 * fine for the former and several minutes for the latter, which a serverless
 * request does not have.
 *
 * Same conflict rule as the single-row path, so re-uploading a corrected file
 * overwrites cleanly rather than erroring or duplicating.
 */
export async function writeReadingsBulk(
  petId: string,
  sourceId: string,
  readings: Reading[],
  chunkSize = 500
): Promise<number> {
  const rows = readings
    .filter((r) => isKnownMetric(r.metric) && Number.isFinite(r.value))
    .map((r) => ({
      pet_id: petId,
      date: r.date,
      metric: r.metric,
      value: r.value,
      source_id: sourceId,
    }));

  const s = sql();
  let written = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    await s`insert into daily_metrics ${s(chunk, "pet_id", "date", "metric", "value", "source_id")}
      on conflict (pet_id, date, metric) do update set
        value = excluded.value, source_id = excluded.source_id, updated_at = now()`;
    written += chunk.length;
  }
  return written;
}

/** What is already stored for the recent window, for the repair decision. */
export async function storedDays(petId: string, probes: string[], since: string): Promise<StoredDay[]> {
  if (probes.length === 0) return [];
  const rows = await sql()`select date::text as date,
      count(distinct metric)::int as metrics,
      extract(epoch from max(updated_at))::bigint as last_write
    from daily_metrics
    where pet_id = ${petId} and metric = any(${probes}) and date >= ${since}::date
    group by date`;
  return rows.map((r) => ({
    date: r.date as string,
    metricCount: Number(r.metrics),
    lastWriteEpoch: Number(r.last_write),
  }));
}

export async function readSeries(petId: string, metric: string): Promise<DayPoint[]> {
  const rows = await sql()`select date::text as date, value from daily_metrics
    where pet_id = ${petId} and metric = ${metric} order by date asc`;
  return rows.map((r) => ({ date: r.date as string, value: Number(r.value) }));
}

export async function startRun(sourceId: string, trigger: string): Promise<number> {
  const [row] = await sql()`insert into runs (source_id, kind) values (${sourceId}, ${trigger})
    returning id`;
  return Number(row.id);
}

export async function finishRun(
  id: number,
  ok: boolean,
  daysWritten: number,
  error?: string
): Promise<void> {
  await sql()`update runs set finished_at = now(), ok = ${ok},
      days_written = ${daysWritten}, error = ${error ?? null}
    where id = ${id}`;
}
