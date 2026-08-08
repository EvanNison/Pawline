/**
 * Evaluating stored readings, separately from fetching them.
 *
 * Split out of the collect route because alerting is not a property of
 * collection: readings can arrive by CSV upload, and previously did so without
 * ever being judged. The collect route refused to go any further when no
 * vendor source was scheduled, so an import-only install got charts and never
 * a single alert — while the setup guide said the app worked fully without
 * connecting a vendor account.
 */

import { sql } from "./db";
import { REGISTRY, MIN_WEAR_MINUTES } from "./metrics";
import { readSeries } from "./store";
import { alertSeries, isCurrent, shouldWithdraw } from "./alerting";
import { detectDeviation } from "./baseline";
import { isEmailConfigured, sendAlertEmail, type AlertRecord } from "./notify";

/**
 * Raise new alerts and withdraw resolved ones.
 *
 * Order matters and is load-bearing: raise, then notify (below), then
 * withdraw. Withdrawing first deletes an alert whose email failed yesterday
 * the moment today looks normal, so the deviation is never reported at all.
 */
export async function raiseAndWithdrawAlerts(petId: string, today: string, muted: string[]): Promise<void> {
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
        // `muted` is refreshed too. Copying it only at insert meant muting a
        // measurement never silenced an episode already open, and unmuting one
        // never un-silenced it — the setting appeared to do nothing, or
        // silently kept suppressing after being turned off.
        await s`update alerts set direction = ${dev.direction}, value = ${dev.value},
            baseline_median = ${dev.baseline.median}, baseline_spread = ${dev.baseline.smad},
            severity = ${dev.severity}, days_outside = ${dev.daysOutside},
            muted = ${muted.includes(def.key)}
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
    // Dismissed episodes are resolved too. Excluding them meant an alert the
    // owner had silenced could never be recorded as recovered, so the dashboard
    // went on saying the measurement "has not returned to its usual range"
    // permanently -- an untrue statement about their pet, kept alive by the
    // fact that they had asked to stop being shouted at.
    //
    // Resolution is evidence, not a display state: whether someone dismissed
    // the warning has no bearing on whether the metric came back.
    //
    // Undelivered rows are resolved as well and still sent, because delivery
    // does not filter on resolved and renderAlertLine then says "has since
    // returned to normal" instead of reporting a condition already known ended.
    await s`update alerts set resolved = true, resolved_at = now()
      where pet_id = ${petId} and metric = ${metric} and resolved = false`;
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
export async function deliverPendingAlerts(
  units: "metric" | "imperial",
  muted: string[] = []
): Promise<void> {
  const s = sql();
  // Muting is applied SOLELY from the current setting, never from the flag
  // stored on the row -- that flag exists to show "notifications muted" in the
  // history and is a snapshot of the past. Testing both meant an alert created
  // while muted stayed undeliverable forever once unmuted. The flag is only refreshed while a deviation is still being detected,
  // so a queued alert for a metric that has since settled kept whatever value it
  // was created with — and muting a noisy measurement did not stop the email
  // already waiting to go out, which is exactly the case someone mutes for.
  const pending = await s`select a.id, a.date::text as date, a.metric, a.direction, a.value,
      a.baseline_median, a.severity, a.days_outside, a.note, a.resolved,
      a.pet_id, p.name as pet
    from alerts a join pets p on p.id = a.pet_id
    where a.emailed = false and a.acknowledged = false
      and a.metric <> all(${muted})
    order by a.date desc limit 50`;
  if (pending.length === 0) return;
  if (!(await isEmailConfigured())) return;

  // One email per pet. A single email covering everyone was titled with
  // whichever pet happened to sort first, so in a two-animal household an alert
  // about one arrived under the other's name — and the whole point of the email
  // is to tell you which animal to look at.
  // Grouped by pet id, not by display name. Two animals can share a name --
  // and grouping on the name merged them into one email whose lines carry no
  // identity at all, which is the same wrong-animal failure this grouping was
  // introduced to fix.
  const byPet = new Map<string, typeof pending>();
  for (const row of pending) {
    const id = String(row.pet_id);
    const list = byPet.get(id);
    if (list) list.push(row);
    else byPet.set(id, [row] as typeof pending);
  }

  for (const rows of byPet.values()) {
    const petName = String(rows[0].pet ?? "your pet");
    const records: AlertRecord[] = rows.map((a) => ({
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

    // Marked per pet, so one pet's send failing does not silence another's
    // alerts by flagging them as delivered.
    const { sent } = await sendAlertEmail(petName, records, units);
    if (sent) {
      await s`update alerts set emailed = true where id = any(${records.map((r) => r.id)})`;
    }
  }
}
