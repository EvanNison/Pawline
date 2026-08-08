/**
 * CSV import.
 *
 * The zero-risk source: no vendor, no credentials, no terms to accept. It is a
 * format a person can write by hand, and the one an exporter should eventually
 * produce so history can always be taken elsewhere. **No exporter exists yet** —
 * do not describe this as round-trip until one does.
 *
 * Expected shape — one row per day, one column per metric:
 *
 *     date,resting_heart_rate,night_sleep_minutes,weight_lb
 *     2026-08-01,62,481,32.0
 *     2026-08-02,63,455,
 *
 * A `pet` column is optional; without one, every row belongs to a single pet.
 *
 * Units are declared in the header, never assumed. `weight_lb` and `weight_kg`
 * are converted on import; a bare `weight` is REFUSED rather than guessed at,
 * because guessing silently mis-scales a chart a vet reads. Same for distance.
 */

import { isKnownMetric, metric as metricDef, type Species } from "../metrics";
import { toCanonical, type Dimension, type UnitSystem } from "../units";
import type { Reading, Source, SourceInfo, SourcePet } from "./types";

export const CSV_SOURCE_INFO: SourceInfo = {
  id: "csv",
  label: "CSV file",
  description: "Import a spreadsheet of daily readings, from any tracker or kept by hand.",
  risk: "none",
};

/** Header suffixes that pin a column to a unit, per dimension. */
const UNIT_SUFFIXES: Record<string, { dimension: Dimension; system: UnitSystem }> = {
  kg: { dimension: "mass", system: "metric" },
  lb: { dimension: "mass", system: "imperial" },
  lbs: { dimension: "mass", system: "imperial" },
  km: { dimension: "distance", system: "metric" },
  mi: { dimension: "distance", system: "imperial" },
};

export interface ParseWarning {
  row: number; // 1-based, counting the header as row 1
  message: string;
}

export interface ParsedCsv {
  pets: string[];
  readings: Reading[];
  warnings: ParseWarning[];
}

/** RFC4180-ish splitter: handles quoted fields, embedded commas and quotes. */
function splitRow(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") {
      // A quote only opens a field at its start. Treating one anywhere as CSV
      // syntax silently deleted it: `6"2` became `62` and was stored as a
      // heart rate. Mid-field quotes are kept verbatim so the value fails
      // number parsing and is reported instead.
      quoted = true;
    } else if (c === ",") {
      out.push(field);
      field = "";
    } else field += c;
  }
  out.push(field);
  return out.map((f) => f.trim());
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * Plain decimal only. `Number()` also accepts 0x3e, 0b111, 1e3 and whitespace,
 * so a typo or a stray hex-looking code silently became a health reading — 0x3e
 * arrived as a heart rate of 62 with no warning at all.
 */
const NUMBER_RE = /^[+-]?(\d+(\.\d+)?|\.\d+)$/;

function isRealDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

interface Column {
  metric: string;
  convert: (v: number) => number;
}

/** Resolve a header cell to a metric and its unit conversion, or a reason why not. */
/**
 * Dimensions whose canonical unit is not what a person would ever write.
 *
 * Mass is stored in grams and distance in metres. Nobody writing a spreadsheet
 * by hand means either: `weight,32` means a 32 lb or 32 kg dog, and accepting
 * it as 32 grams stored a plausible-looking number that was wrong by three
 * orders of magnitude, on the measurement a vet reads most closely. Refusing is
 * the only safe answer, because there is no way to tell which they meant.
 */
const UNIT_REQUIRED = new Set<Dimension>(["mass", "distance"]);

function resolveColumn(header: string): Column | string {
  const key = header.toLowerCase().replace(/\s+/g, "_");
  if (isKnownMetric(key)) {
    const def = metricDef(key)!;
    if (UNIT_REQUIRED.has(def.dimension)) {
      const suffixes = Object.entries(UNIT_SUFFIXES)
        .filter(([, u]) => u.dimension === def.dimension)
        .map(([suffix]) => `${key}_${suffix}`);
      return `column "${header}" needs its unit in the name — use ${suffixes.join(" or ")}`;
    }
    return { metric: key, convert: (v) => v };
  }

  const underscore = key.lastIndexOf("_");
  if (underscore > 0) {
    const base = key.slice(0, underscore);
    const suffix = key.slice(underscore + 1);
    const unit = UNIT_SUFFIXES[suffix];
    if (unit && isKnownMetric(base)) {
      const def = metricDef(base)!;
      if (def.dimension !== unit.dimension) {
        return `column "${header}" uses a ${unit.dimension} unit for ${base}, which is measured in ${def.dimension}`;
      }
      return { metric: base, convert: (v) => toCanonical(v, unit.dimension, unit.system) };
    }
    if (unit) return `column "${header}" looks like a unit on unknown metric "${base}"`;
  }
  return `unknown metric column "${header}"`;
}

export function parseCsv(
  text: string,
  defaultPetName = "My pet",
  opts: { today?: string } = {}
): ParsedCsv {
  const warnings: ParseWarning[] = [];
  const readings: Reading[] = [];
  const pets = new Set<string>();

  // Strip a UTF-8 BOM (Excel adds one) and normalise line endings.
  const lines = text.replace(/^﻿/, "").split(/\r\n|\n|\r/);
  const headerIdx = lines.findIndex((l) => l.trim() !== "");
  if (headerIdx === -1) return { pets: [], readings: [], warnings: [{ row: 1, message: "file is empty" }] };

  const header = splitRow(lines[headerIdx]).map((h) => h.toLowerCase());
  const dateCol = header.indexOf("date");
  if (dateCol === -1) {
    return { pets: [], readings: [], warnings: [{ row: headerIdx + 1, message: 'no "date" column found' }] };
  }
  const petCol = header.indexOf("pet");

  const columns = new Map<number, Column>();
  header.forEach((h, i) => {
    if (i === dateCol || i === petCol || h === "") return;
    const resolved = resolveColumn(h);
    if (typeof resolved === "string") warnings.push({ row: headerIdx + 1, message: `${resolved} — skipped` });
    else columns.set(i, resolved);
  });

  if (columns.size === 0) {
    warnings.push({ row: headerIdx + 1, message: "no recognised metric columns" });
    return { pets: [], readings, warnings };
  }

  const seen = new Set<string>();

  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === "") continue;
    const rowNo = i + 1;
    const cells = splitRow(lines[i]);
    // A row with the wrong number of cells shifts every value after the extra
    // one. `2026-08-01,14,515,62` against three headers silently imported a
    // weight of 14 and a heart rate of 515 — both plausible-looking numbers in
    // the wrong columns, with no warning. Unquoted thousands separators are
    // exactly how a spreadsheet produces this.
    if (cells.length !== header.length) {
      warnings.push({
        row: rowNo,
        message: `row has ${cells.length} values but the header has ${header.length} — skipped (an unquoted comma inside a number?)`,
      });
      continue;
    }
    const date = cells[dateCol] ?? "";
    if (!isRealDate(date)) {
      warnings.push({ row: rowNo, message: `"${date}" is not a valid YYYY-MM-DD date — row skipped` });
      continue;
    }
    // A reading cannot describe a day that has not happened. Accepting one was
    // not merely untidy: a future date has a negative age, so the freshness
    // check called it current, the history gate accepted it, and the dashboard
    // showed a green "nothing unusual" built entirely from impossible data. A
    // spreadsheet with a mis-parsed date column is the ordinary way this
    // happens, not an attack.
    if (opts.today && date > opts.today) {
      warnings.push({
        row: rowNo,
        message: `"${date}" is in the future — row skipped (check the date format in your export)`,
      });
      continue;
    }
    const petName = (petCol >= 0 ? cells[petCol] : "") || defaultPetName;
    pets.add(petName);

    for (const [idx, col] of columns) {
      const cell = cells[idx];
      if (cell === undefined || cell === "") continue; // a blank is "not measured", not zero
      if (!NUMBER_RE.test(cell)) {
        warnings.push({ row: rowNo, message: `${col.metric}: "${cell}" is not a plain number — skipped` });
        continue;
      }
      const n = Number(cell);
      if (!Number.isFinite(n)) {
        warnings.push({ row: rowNo, message: `${col.metric}: "${cell}" is not a number — skipped` });
        continue;
      }
      // No health metric here can be negative; a minus sign means a broken
      // export or a stray character, not a measurement.
      if (n < 0) {
        warnings.push({ row: rowNo, message: `${col.metric}: ${n} is negative — skipped` });
        continue;
      }
      // The registry declares what each measurement can physically be. A sleep
      // score of 999 out of 100 is a broken export, and storing it drags the
      // baseline for that metric into nonsense — quietly, because the chart
      // just rescales around it. Checked AFTER unit conversion, so the bounds
      // and the value are in the same units.
      const converted = col.convert(n);
      const def = metricDef(col.metric);
      if (def) {
        const low = def.min ?? -Infinity;
        const high = def.max ?? Infinity;
        if (converted < low || converted > high) {
          warnings.push({
            row: rowNo,
            message: `${col.metric}: ${n} is outside the possible range (${low}–${high}) — skipped`,
          });
          continue;
        }
      }
      // Duplicate pet+date+metric would collide on the primary key. Warn rather
      // than let last-write-win decide silently.
      const dedupe = `${petName} ${date} ${col.metric}`;
      if (seen.has(dedupe)) {
        warnings.push({ row: rowNo, message: `duplicate ${col.metric} for ${petName} on ${date} — kept the first` });
        continue;
      }
      seen.add(dedupe);
      readings.push({ petKey: petName, date, metric: col.metric, value: converted });
    }
  }

  return { pets: [...pets], readings, warnings };
}

export interface ImportSummary {
  pets: string[];
  readings: number;
  days: number;
  from: string | null;
  to: string | null;
  /** Reading count per metric, descending — what actually arrived. */
  byMetric: { metric: string; count: number }[];
  warnings: ParseWarning[];
  /** Warnings beyond those listed, so a truncated list never reads as complete. */
  hiddenWarnings: number;
}

/**
 * Describe what a parsed file would import, for the confirmation screen.
 *
 * Pure and separate from the page, because this is the screen someone reads
 * before trusting years of data to the app, and a page cannot be tested. The
 * warning count is carried explicitly: showing ten of four hundred problems
 * with no indication of the rest would make a broken export look clean.
 */
export function summarizeImport(parsed: ParsedCsv, maxWarnings = 25): ImportSummary {
  const dates = new Set<string>();
  const counts = new Map<string, number>();
  for (const r of parsed.readings) {
    dates.add(r.date);
    counts.set(r.metric, (counts.get(r.metric) ?? 0) + 1);
  }
  const sorted = [...dates].sort();
  return {
    pets: parsed.pets,
    readings: parsed.readings.length,
    days: dates.size,
    from: sorted[0] ?? null,
    to: sorted[sorted.length - 1] ?? null,
    byMetric: [...counts.entries()]
      .map(([metric, count]) => ({ metric, count }))
      .sort((a, b) => b.count - a.count || a.metric.localeCompare(b.metric)),
    warnings: parsed.warnings.slice(0, maxWarnings),
    hiddenWarnings: Math.max(0, parsed.warnings.length - maxWarnings),
  };
}

/** A Source backed by an already-uploaded CSV. */
export class CsvSource implements Source {
  readonly info = CSV_SOURCE_INFO;
  private readonly parsed: ParsedCsv;
  private readonly species: Species;
  private readonly timezone: string;

  constructor(text: string, opts: { species?: Species; timezone: string; defaultPetName?: string; today?: string }) {
    this.parsed = parseCsv(text, opts.defaultPetName, { today: opts.today });
    this.species = opts.species ?? "unknown";
    this.timezone = opts.timezone;
  }

  get warnings(): ParseWarning[] {
    return this.parsed.warnings;
  }

  async check(): Promise<string | null> {
    if (this.parsed.readings.length === 0) {
      return this.parsed.warnings[0]?.message ?? "no readings found in the file";
    }
    return null;
  }

  async listPets(): Promise<SourcePet[]> {
    return this.parsed.pets.map((name) => ({
      key: name,
      name,
      species: this.species,
      timezone: this.timezone,
      capabilities: [
        ...new Set(this.parsed.readings.filter((r) => r.petKey === name).map((r) => r.metric)),
      ],
    }));
  }

  async fetchDay(petKey: string, date: string): Promise<Reading[]> {
    return this.parsed.readings.filter((r) => r.petKey === petKey && r.date === date);
  }

  /** Every date present for a pet, ascending — lets the importer skip empty days. */
  datesFor(petKey: string): string[] {
    return [...new Set(this.parsed.readings.filter((r) => r.petKey === petKey).map((r) => r.date))].sort();
  }
}
