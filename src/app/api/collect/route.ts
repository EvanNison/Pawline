import { NextRequest, NextResponse } from "next/server";
import { ensureSchema, sql } from "@/lib/db";
import { readSettings } from "@/lib/settings";
import { upgradeStoredSecrets } from "@/lib/secrets";
import { scheduledSources } from "@/lib/sources/registry";
import { datesToCollect, runOutcome } from "@/lib/collector";
import { finishRun, readSeries, startRun, storedDays, upsertPet, writeReadings } from "@/lib/store";
import { addDays, dayRangeEpoch, localDate } from "@/lib/time";
import { REGISTRY, MIN_WEAR_MINUTES } from "@/lib/metrics";
import { alertSeries, isCurrent, shouldWithdraw } from "@/lib/alerting";
import { detectDeviation } from "@/lib/baseline";
import { isEmailConfigured, sendAlertEmail, type AlertRecord } from "@/lib/notify";

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

  const sources = await scheduledSources();
  if (sources.length === 0) {
    return NextResponse.json(
      { ok: false, error: "No source is enabled for scheduled collection." },
      { status: 400 }
    );
  }

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
          for (const date of dates) {
            const readings = await source.fetchDay(pet.key, date);
            if (readings.length > 0) {
              await writeReadings(petId, source.info.id, readings);
              written.add(date);
            }
          }
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

  await deliverPendingAlerts(settings.units);

  return NextResponse.json({ ok: !anyFailure, results: summary }, { status: anyFailure ? 502 : 200 });
}

/**
 * Raise new alerts and withdraw resolved ones.
 *
 * Order matters and is load-bearing: raise, then notify (below), then
 * withdraw. Withdrawing first deletes an alert whose email failed yesterday
 * the moment today looks normal, so the deviation is never reported at all.
 */
async function raiseAndWithdrawAlerts(petId: string, today: string, muted: string[]): Promise<void> {
  const s = sql();

  const lowWearRows = await s`select date::text as date from daily_metrics
    where pet_id = ${petId} and metric = 'wear_time' and value < ${MIN_WEAR_MINUTES}`;
  const lowWear = new Set(lowWearRows.map((r) => r.date as string));
  const withdrawals: string[] = [];

  for (const def of REGISTRY.filter((d) => d.alert)) {
    const series = alertSeries(await readSeries(petId, def.key), def.key, { today, lowWear });
    const dev = detectDeviation(series, def.key, def.direction);

    if (dev && isCurrent(dev.date, today)) {
      // One row per episode, not one per day of it: an ongoing condition moves
      // its date forward daily, which would otherwise mean a fresh alert and a
      // fresh email every run.
      const [open] = await s`select id from alerts
        where pet_id = ${petId} and metric = ${def.key}
          and acknowledged = false and resolved = false
        order by date asc limit 1`;
      if (open) {
        await s`update alerts set direction = ${dev.direction}, value = ${dev.value},
            baseline_median = ${dev.baseline.median}, baseline_spread = ${dev.baseline.smad},
            severity = ${dev.severity}, days_outside = ${dev.daysOutside}
          where id = ${Number(open.id)}`;
      } else {
        await s`insert into alerts
          (pet_id, date, metric, direction, value, baseline_median, baseline_spread,
           severity, days_outside, muted)
          values (${petId}, ${dev.date}, ${def.key}, ${dev.direction}, ${dev.value},
                  ${dev.baseline.median}, ${dev.baseline.smad}, ${dev.severity},
                  ${dev.daysOutside}, ${muted.includes(def.key)})
          on conflict (pet_id, date, metric) do nothing`;
      }
    } else if (shouldWithdraw(series, dev !== null, today, def.direction)) {
      withdrawals.push(def.key);
    }
  }

  // Applied after the send pass, in deliverPendingAlerts, so nothing pending is
  // destroyed before it has been reported.
  for (const metric of withdrawals) {
    await s`update alerts set resolved = true, resolved_at = now()
      where pet_id = ${petId} and metric = ${metric}
        and acknowledged = false and resolved = false and emailed = true`;
    // Undelivered rows stay until they are sent, or until the grace period ends.
    await s`update alerts set resolved = true, resolved_at = now()
      where pet_id = ${petId} and metric = ${metric}
        and acknowledged = false and resolved = false and emailed = false
        and date < ${today}::date - 14`;
  }
}

/**
 * One send pass over stored rows, marking exactly what it sent.
 *
 * Driven off the database rather than this run's findings, so a transient
 * failure is retried next time. Muted metrics are excluded from delivery but
 * still recorded and still shown — a mute that hid the row would make a
 * suppressed detection invisible.
 */
async function deliverPendingAlerts(units: "metric" | "imperial"): Promise<void> {
  const s = sql();
  const pending = await s`select a.id, a.date::text as date, a.metric, a.direction, a.value,
      a.baseline_median, a.severity, a.days_outside, a.note, a.resolved, p.name as pet
    from alerts a join pets p on p.id = a.pet_id
    where a.emailed = false and a.acknowledged = false and a.muted = false
    order by a.date desc limit 50`;
  if (pending.length === 0) return;
  if (!(await isEmailConfigured())) return;

  const records: AlertRecord[] = pending.map((a) => ({
    id: Number(a.id),
    date: a.date as string,
    metric: a.metric as string,
    direction: a.direction as string,
    value: a.value === null ? null : Number(a.value),
    baseline_median: a.baseline_median === null ? null : Number(a.baseline_median),
    severity: a.severity as string,
    days_outside: a.days_outside === null ? null : Number(a.days_outside),
    note: (a.note as string | null) ?? null,
    resolved: Boolean(a.resolved),
  }));

  const petName = String(pending[0].pet ?? "your pet");
  const { sent } = await sendAlertEmail(petName, records, units);
  if (sent) {
    await s`update alerts set emailed = true where id = any(${records.map((r) => r.id)})`;
  }
}
