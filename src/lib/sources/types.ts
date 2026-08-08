/**
 * Data sources.
 *
 * Pawline analyses pet health data; it does not care where the data came from.
 * Every ingestion path implements this interface, which keeps three things true:
 *
 *   1. The project is not "a client for one vendor's private API". Vendor
 *      access is one adapter among several, and users choose it knowingly.
 *   2. When a vendor changes or blocks its API, one adapter breaks — the stored
 *      history, the baselines, and the vet report do not.
 *   3. Adapters can be tested against recorded fixtures with no network and no
 *      real account.
 *
 * An adapter NEVER returns a bare number. Every reading names a metric whose
 * canonical unit is declared in metrics.ts, and the adapter is responsible for
 * converting into it.
 */

import type { Species } from "../metrics";

export interface Reading {
  /** Stable identifier for the pet *within this source*. */
  petKey: string;
  /** YYYY-MM-DD in the pet's local timezone. */
  date: string;
  /** Canonical metric key — must exist in metrics.ts REGISTRY. */
  metric: string;
  /** Value in the metric's canonical unit. Never a vendor-native unit. */
  value: number;
}

export interface SourcePet {
  key: string;
  name: string;
  species: Species;
  /** IANA timezone if the source knows it; the app prompts when it doesn't. */
  timezone?: string;
  /**
   * Metric keys this pet's hardware can actually produce. The UI hides
   * everything else rather than drawing empty charts that look like a health
   * signal ("no barking data" must not read as "no barking").
   */
  capabilities: string[];
}

export type RiskLevel = "none" | "vendor-terms" | "experimental";

export interface SourceInfo {
  id: string;
  label: string;
  /** One line describing where the data comes from. */
  description: string;
  risk: RiskLevel;
  /**
   * Shown, unskippable, before a user may enable a source whose risk is not
   * "none". Quote the actual terms — do not paraphrase them into vagueness.
   */
  advisory?: string;
}

export interface Source {
  readonly info: SourceInfo;
  /** Verify credentials / file access. Returns a human-readable problem, or null. */
  check(): Promise<string | null>;
  listPets(): Promise<SourcePet[]>;
  /**
   * Readings for one pet-day. Must be idempotent and safe to re-run: the
   * importer calls this repeatedly while walking history, and re-running a day
   * has to produce the same rows rather than duplicates.
   *
   * Return [] for a day the source has no data for. Throw only on transport or
   * auth failures the caller should retry or surface.
   */
  fetchDay(petKey: string, date: string): Promise<Reading[]>;

  /**
   * Readings that describe the pet right now rather than a past day — a profile
   * weight, say. Optional; sources without such values omit it.
   *
   * Called once per pet per run and stamped with today only. Writing a current
   * value onto historical dates would fabricate a flat history for the very
   * measurement a vet reads most closely.
   */
  fetchCurrent?(petKey: string, today: string): Promise<Reading[]>;
}
