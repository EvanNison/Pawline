import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, sql } from "@/lib/db";
import { readSettings } from "@/lib/settings";
import { upgradeStoredSecrets } from "@/lib/secrets";
import { scheduledSources } from "@/lib/sources/registry";
import { datesToCollect, runOutcome } from "@/lib/collector";
import { addCapability, finishRun, listPets, startRun, storedDays, upsertPet, writeReadings } from "@/lib/store";
import { addDays, dayRangeEpoch, localDate } from "@/lib/time";
import { deliverPendingAlerts, raiseAndWithdrawAlerts } from "@/lib/alert-run";

export const maxDuration = 300;

/** How far back to look for days needing repair, and how many to fix per run. */
const RECOVERY_WINDOW = 14;
const MAX_RECOVERY_DAYS = 8;
/** Metrics whose presence marks a day as recorded. */
const PROBES = ["active_minutes", "night_sleep_minutes", "wear_time"];

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // Fail closed. Treating a missing secret as "allow" opens the route to
    // anyone who finds the URL the moment a deploy loses its configuration.
    return process.env.NODE_ENV !== "production";
  }
  return req.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  await ensureSchema();
  const s = sql();
  const settings = await readSettings();

  // Encrypt anything still stored in the clear. Done here rather than on the
  // read path: credentials are only read when a login happens, and a cached
  // token makes that rare enough that an upgrade-on-read can sit unperformed.
  await upgradeStoredSecrets(s).catch((e) =>
    console.error("[collect] secret upgrade skipped:", String(e).slice(0, 200))
  );

  // Deliberately not an early return. Alerting is not a property of
  // collection: readings can arrive by CSV upload, and an import-only install
  // used to get charts and never a single alert because this route refused to
  // go any further. Whether a source is *scheduled* is reported by /status,
  // which is the page that exists to say so.
  const sources = await scheduledSources();

  const summary: Record<string, unknown>[] = [];
  let anyFailure = false;

  for (const source of sources) {
    const runId = await startRun(source.info.id, req.headers.get("authorization") ? "cron" : "manual");
    let daysWritten = 0;
    try {
      const pets = await source.listPets();
      const [{ count: known }] = await s`select count(*)::int as count from pets
        where source_id = ${source.info.id}`;

      const outcome = runOutcome({
        petsFound: pets.length,
        petsKnownPreviously: Number(known),
        petsFailed: 0,
      });
      if (!outcome.ok) {
        await finishRun(runId, false, 0, outcome.reason);
        summary.push({ source: source.info.id, error: outcome.reason });
        anyFailure = true;
        continue;
      }

      let failed = 0;
      for (const pet of pets) {
        try {
          const tz = pet.timezone ?? settings.timezone;
          const today = localDate(tz);
          const petId = await upsertPet(source.info.id, pet, settings.timezone);

          const stored = await storedDays(petId, PROBES, addDays(today, -RECOVERY_WINDOW));
          const dates = datesToCollect(stored, {
            today,
            window: RECOVERY_WINDOW,
            limit: MAX_RECOVERY_DAYS,
            probeCount: PROBES.filter((p) => pet.capabilities.includes(p)).length || 1,
            dayEndEpoch: (d) => dayRangeEpoch(d, tz)[1],
          });

          const written = new Set<string>();
          const collected = new Set<string>();
          for (const date of dates) {
            const readings = await source.fetchDay(pet.key, date);
            if (readings.length > 0) {
              await writeReadings(petId, source.info.id, readings);
              written.add(date);
              for (const r of readings) collected.add(r.metric);
            }
          }
          // Values that describe the pet now rather than a past day — the
          // profile weight. The adapter advertised weight in its capabilities
          // and implemented the fetch, and nothing ever called it, so the one
          // measurement vets ask about most was never collected. Stamped with
          // today only, never backfilled across the window.
          if (source.fetchCurrent) {
            try {
              const current = await source.fetchCurrent(pet.key, today);
              if (current.length > 0) {
                await writeReadings(petId, source.info.id, current);
                for (const r of current) await addCapability(petId, r.metric);
              }
            } catch (e) {
              // A profile read failing must not lose the day's collected data.
              console.error("[collect] current-value fetch failed:", String(e).slice(0, 200));
            }
          }

          // Credit the pet with every metric that actually arrived. Adapters
          // declare capabilities from what the device advertises, and a real
          // Tractive collar returned sleep, heart rate and respiratory data
          // while advertising none of it — so the dashboard filtered all of it
          // back out and showed nothing. What a tracker demonstrably produces
          // is better evidence than what it claims to support.
          for (const key of collected) await addCapability(petId, key);

          daysWritten += written.size;

          await raiseAndWithdrawAlerts(petId, today, settings.mutedMetrics);
          summary.push({ source: source.info.id, pet: pet.name, days: [...written].sort() });
        } catch (e) {
          // Isolate per pet: one broken tracker must not stop the others.
          failed++;
          anyFailure = true;
          summary.push({ source: source.info.id, pet: pet.name, error: String(e).slice(0, 300) });
        }
      }

      const final = runOutcome({ petsFound: pets.length, petsKnownPreviously: Number(known), petsFailed: failed });
      await finishRun(runId, final.ok, daysWritten, final.reason);
    } catch (e) {
      anyFailure = true;
      await finishRun(runId, false, daysWritten, String(e).slice(0, 500));
      summary.push({ source: source.info.id, error: String(e).slice(0, 300) });
    }
  }

  // Judge every stored pet, not only the ones a source just wrote to. An
  // imported pet has no scheduled source and would otherwise never be assessed.
  // Idempotent, so pets already handled above cost a re-read and nothing more.
  // Recorded as a run in its own right when nothing was scheduled to fetch.
  // Otherwise an import-only install writes no run at all, and /status can never
  // confirm the nightly job happened — it would say "never collected" forever
  // while quietly working.
  const alertRunId = sources.length === 0
    ? await startRun("alerts", req.headers.get("authorization") ? "cron" : "manual")
    : null;

  const evaluated: string[] = [];
  for (const pet of await listPets()) {
    try {
      await raiseAndWithdrawAlerts(pet.id, localDate(pet.timezone), settings.mutedMetrics);
      evaluated.push(pet.id);
    } catch (e) {
      anyFailure = true;
      summary.push({ pet: pet.name, error: `alerting failed: ${String(e).slice(0, 200)}` });
    }
  }

  if (alertRunId !== null) {
    await finishRun(alertRunId, !anyFailure, 0, anyFailure ? "alert evaluation failed" : undefined);
  }

  await deliverPendingAlerts(settings.units, settings.mutedMetrics);

  return NextResponse.json(
    { ok: !anyFailure, sourcesScheduled: sources.length, petsEvaluated: evaluated.length, results: summary },
    { status: anyFailure ? 502 : 200 }
  );
}
