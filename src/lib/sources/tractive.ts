/**
 * Tractive account adapter.
 *
 * This is the one source with a real risk attached — see the advisory in
 * registry.ts, and section 9 of docs/DECISIONS.md. It cannot run without a
 * recorded acknowledgement.
 *
 * All payload interpretation lives in tractive-map.ts, which is pure and tested
 * against fixtures. This file only fetches and stores.
 */

import { sql } from "../db";
import { reveal } from "../secrets";
import { addDays, dayRangeEpoch } from "../time";
import {
  capabilitiesToMetrics,
  mapBiometric,
  mapDayOverview,
  mapProfileWeight,
  type DayKind,
} from "./tractive-map";
import { TRACTIVE_SOURCE_INFO } from "./registry";
import type { Reading, Source, SourcePet } from "./types";

const GRAPH = "https://graph.tractive.com/4";
const APS = "https://aps-api.tractive.com/api/1";
const CLIENT_ID = process.env.TRACTIVE_CLIENT_ID || "625e533dc3c3b41c28a669f0";

const BASE_HEADERS: Record<string, string> = {
  "x-tractive-client": CLIENT_ID,
  "content-type": "application/json;charset=UTF-8",
  accept: "application/json, text/plain, */*",
};

interface Token {
  userId: string;
  accessToken: string;
  expiresAt: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class TractiveSource implements Source {
  readonly info = TRACTIVE_SOURCE_INFO;
  private token: Token | null = null;

  private constructor(
    private readonly email: string,
    private readonly password: string,
    private readonly timezone: string
  ) {}

  /** Null when no credentials are stored — not an error, just not set up. */
  static async fromStoredCredentials(): Promise<TractiveSource | null> {
    const [row] = await sql()`select value from app_config where key = 'source:tractive:credentials'`;
    if (!row) return null;
    const opened = await reveal(String(row.value));
    if (!opened.ok) {
      console.error("[tractive] stored credentials unusable:", opened.reason);
      return null;
    }
    const { email, password } = JSON.parse(opened.value) as { email: string; password: string };
    const [tz] = await sql()`select value from app_config where key = 'timezone'`;
    return new TractiveSource(email, password, String(tz?.value ?? "UTC"));
  }

  private async login(): Promise<Token> {
    const res = await fetch(`${GRAPH}/auth/token`, {
      method: "POST",
      headers: BASE_HEADERS,
      body: JSON.stringify({
        platform_email: this.email,
        platform_token: this.password,
        grant_type: "tractive",
      }),
    });
    if (!res.ok) throw new Error(`Tractive login failed: ${res.status}`);
    const data = await res.json();
    this.token = {
      userId: data.user_id,
      accessToken: data.access_token,
      expiresAt: Number(data.expires_at) || Math.floor(Date.now() / 1000) + 3600,
    };
    return this.token;
  }

  private async authed(): Promise<Token> {
    // Refresh an hour early rather than waiting for a 401, so a scheduled run
    // does not spend its first request discovering the token died.
    if (this.token && this.token.expiresAt - 3600 > Date.now() / 1000) return this.token;
    return this.login();
  }

  private async get(url: string, { allow404 = false } = {}): Promise<unknown | null> {
    let token = await this.authed();
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(url, {
        headers: {
          ...BASE_HEADERS,
          authorization: `Bearer ${token.accessToken}`,
          "x-tractive-user": token.userId,
        },
      });
      if (res.ok) return res.json();
      if (res.status === 401 && attempt === 0) {
        token = await this.login();
        continue;
      }
      if (res.status === 429) {
        const wait = (Number(res.headers.get("retry-after")) || 15) + Math.random() * 5;
        await sleep(wait * 1000);
        continue;
      }
      // 400 and 404 on a per-day endpoint mean "this device does not report
      // that", which is information rather than failure.
      if (allow404 && (res.status === 404 || res.status === 400)) return null;
      throw new Error(`Tractive GET failed: ${res.status}`);
    }
    throw new Error("Tractive GET: retries exhausted");
  }

  async check(): Promise<string | null> {
    try {
      await this.authed();
      return null;
    } catch (e) {
      return String(e);
    }
  }

  /** The account this token belongs to — compared against the expected one. */
  async accountId(): Promise<string> {
    return (await this.authed()).userId;
  }

  async listPets(): Promise<SourcePet[]> {
    const uid = (await this.authed()).userId;
    const objects = (await this.get(`${GRAPH}/user/${uid}/trackable_objects`)) as { _id: string }[];
    const pets: SourcePet[] = [];
    for (const obj of objects ?? []) {
      const details = (await this.get(`${GRAPH}/trackable_object/${obj._id}`)) as Record<string, unknown>;
      const inner = (details?.details ?? {}) as Record<string, unknown>;
      const caps = Array.isArray(details?.capabilities) ? (details.capabilities as string[]) : [];
      pets.push({
        key: obj._id,
        name: (inner.name as string) || (details?.name as string) || obj._id,
        // The vendor models pets by species elsewhere; absent that, say unknown
        // rather than assuming dog, so cat-inapplicable metrics stay hidden.
        species: (inner.pet_type as "dog" | "cat") ?? "unknown",
        timezone: this.timezone,
        capabilities: capabilitiesToMetrics(caps),
      });
    }
    return pets;
  }

  async fetchDay(petKey: string, date: string): Promise<Reading[]> {
    const out: Reading[] = [];
    const [start, end] = dayRangeEpoch(date, this.timezone);
    const daySeconds = end - start;

    for (const kind of ["activity", "sleep", "scratch", "bark"] as DayKind[]) {
      const payload = (await this.get(`${APS}/pet/${petKey}/${kind}/day-overview?date=${date}`, {
        allow404: true,
      })) as Record<string, unknown> | null;
      out.push(...mapDayOverview(kind, payload, petKey, date, daySeconds));
    }

    for (const [endpoint, metric] of [
      ["resting-heart-rate", "resting_heart_rate"],
      ["resting-respiratory-rate", "resting_respiratory_rate"],
    ] as const) {
      const payload = (await this.get(`${APS}/pet/${petKey}/${endpoint}/day-overview?date=${date}`, {
        allow404: true,
      })) as Parameters<typeof mapBiometric>[0];
      out.push(...mapBiometric(payload, metric, petKey, date, addDays));
    }

    return out;
  }

  /**
   * Profile weight, which carries no date of its own.
   *
   * Only ever attributed to today: stamping an undated current value onto
   * historical days during a backwards import would fabricate a flat weight
   * history, for the metric a vet looks at first.
   */
  /** Profile weight. Named for the interface so the collector actually calls it. */
  async fetchCurrent(petKey: string, today: string): Promise<Reading[]> {
    return this.fetchProfileWeight(petKey, today);
  }

  async fetchProfileWeight(petKey: string, today: string): Promise<Reading[]> {
    const details = (await this.get(`${GRAPH}/trackable_object/${petKey}`)) as Record<string, unknown>;
    return mapProfileWeight(details ?? {}, petKey, today, today);
  }
}
