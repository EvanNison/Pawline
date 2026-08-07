/**
 * Is this thing actually working?
 *
 * Pure assessment logic, separated from the page so it can be tested — the
 * three chart bugs that only turned up on the rendered dashboard were all in
 * code no test could reach.
 *
 * One rule governs everything here: **absence of evidence is never reported as
 * good news.** A check with nothing to go on says "unknown", never "ok". The
 * whole point of this page is to catch the failure that looks like health —
 * collection silently stopping while the charts keep showing last month.
 */

export type Level = "ok" | "warn" | "bad" | "unknown";

export interface Check {
  id: string;
  label: string;
  level: Level;
  /** One line, plain enough for a non-technical owner to act on. */
  detail: string;
}

export interface RunRow {
  startedAt: string;
  finishedAt: string | null;
  ok: boolean | null;
  error: string | null;
}

export interface StatusInput {
  now: Date;
  /** Pet-local today, for judging metric freshness. */
  today: string;
  /** Most recent attempt of any kind. */
  lastRun: RunRow | null;
  /** Most recent attempt that finished successfully. */
  lastSuccessAt: string | null;
  /** Newest stored date per alertable metric; null when the metric has none. */
  metricFreshness: { metric: string; label: string; newest: string | null }[];
  emailConfigured: boolean;
  undeliveredAlerts: number;
  credentialsPresent: boolean;
  petCount: number;
}

const HOUR = 3_600_000;
/** The cron is daily; this much silence means a run was missed. */
const COLLECTION_WARN_HOURS = 26;
const COLLECTION_BAD_HOURS = 36;
/** A run still unfinished after this long did not finish. */
const RUN_STUCK_HOURS = 1;
/** Vendor lookbacks heal a day or two; beyond that a metric has stopped. */
const METRIC_WARN_DAYS = 3;
const METRIC_BAD_DAYS = 7;

const hoursSince = (iso: string, now: Date) => (now.getTime() - Date.parse(iso)) / HOUR;
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

function ago(hours: number): string {
  if (hours < 1) return "less than an hour ago";
  if (hours < 48) return `${Math.round(hours)} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

function collectionCheck(input: StatusInput): Check {
  const { lastRun, lastSuccessAt, now } = input;

  if (!lastRun) {
    return {
      id: "collection",
      label: "Data collection",
      level: "unknown",
      detail:
        "No collection has been recorded yet. If this app was just updated that is expected — the first run will appear here.",
    };
  }

  // A run that started and never finished is invisible in every other signal:
  // it writes no snapshot, raises no alert, and leaves the charts untouched.
  if (lastRun.finishedAt === null && hoursSince(lastRun.startedAt, now) > RUN_STUCK_HOURS) {
    return {
      id: "collection",
      label: "Data collection",
      level: "bad",
      detail: `A collection started ${ago(hoursSince(lastRun.startedAt, now))} and never finished. It was cut off partway.`,
    };
  }

  if (!lastSuccessAt) {
    return {
      id: "collection",
      label: "Data collection",
      level: "bad",
      detail: lastRun.error
        ? `No collection has ever succeeded. Last error: ${lastRun.error}`
        : "No collection has ever succeeded.",
    };
  }

  const h = hoursSince(lastSuccessAt, now);
  if (h > COLLECTION_BAD_HOURS) {
    return {
      id: "collection",
      label: "Data collection",
      level: "bad",
      detail:
        `Last succeeded ${ago(h)}. The daily collection is not running — your charts are frozen at that date. ` +
        (lastRun.error ? `Last error: ${lastRun.error}` : "Check Setup: a changed Tractive password stops collection."),
    };
  }
  if (h > COLLECTION_WARN_HOURS) {
    return {
      id: "collection",
      label: "Data collection",
      level: "warn",
      detail: `Last succeeded ${ago(h)} — a run looks to have been missed. One more miss and the charts start falling behind.`,
    };
  }
  return {
    id: "collection",
    label: "Data collection",
    level: "ok",
    detail: `Last succeeded ${ago(h)}.`,
  };
}

function metricChecks(input: StatusInput): Check[] {
  return input.metricFreshness.map(({ metric, label, newest }) => {
    if (!newest) {
      return {
        id: `metric:${metric}`,
        label,
        level: "unknown" as Level,
        // Not "ok". A metric that has never appeared may be unsupported by the
        // tracker, or may have silently stopped being sent — both look the same
        // from here, and neither is reassuring.
        detail: "No readings recorded. Either your tracker does not report this, or it has never arrived.",
      };
    }
    const age = daysBetween(newest, input.today);
    if (age > METRIC_BAD_DAYS) {
      return {
        id: `metric:${metric}`,
        label,
        level: "bad" as Level,
        detail: `Nothing since ${newest} (${age} days). This metric has stopped arriving even though collection is running.`,
      };
    }
    if (age > METRIC_WARN_DAYS) {
      return {
        id: `metric:${metric}`,
        label,
        level: "warn" as Level,
        detail: `Newest reading is ${newest} (${age} days old).`,
      };
    }
    return {
      id: `metric:${metric}`,
      label,
      level: "ok" as Level,
      detail: `Current to ${newest}.`,
    };
  });
}

export function buildStatus(input: StatusInput): Check[] {
  const checks: Check[] = [collectionCheck(input)];

  checks.push(
    input.credentialsPresent
      ? { id: "credentials", label: "Tractive sign-in", level: "ok", detail: "Saved." }
      : {
          id: "credentials",
          label: "Tractive sign-in",
          level: "bad",
          detail: "No saved sign-in. Nothing can be collected until you enter it in Setup.",
        }
  );

  checks.push(
    input.petCount > 0
      ? { id: "pets", label: "Pets", level: "ok", detail: `${input.petCount} found on your account.` }
      : {
          id: "pets",
          label: "Pets",
          level: "unknown",
          detail: "No pets recorded yet — this fills in after the first successful collection.",
        }
  );

  // Not having email is a choice, not a fault; the dashboard is the alternative.
  // But email configured AND something undelivered IS a fault, and it is the
  // one that hides health alerts.
  if (!input.emailConfigured) {
    checks.push({
      id: "email",
      label: "Email alerts",
      level: "unknown",
      detail: "Not set up. Alerts will appear on this dashboard but will not be emailed to you.",
    });
  } else if (input.undeliveredAlerts > 0) {
    checks.push({
      id: "email",
      label: "Email alerts",
      level: "bad",
      detail: `${input.undeliveredAlerts} alert${input.undeliveredAlerts === 1 ? "" : "s"} could not be emailed. Check the Resend key in Setup — a shared sender only delivers to the address that owns the Resend account.`,
    });
  } else {
    checks.push({ id: "email", label: "Email alerts", level: "ok", detail: "Set up, nothing waiting to send." });
  }

  checks.push(...metricChecks(input));
  return checks;
}

/** The single worst level present — what the page's headline should say. */
export function overallLevel(checks: Check[]): Level {
  if (checks.some((c) => c.level === "bad")) return "bad";
  if (checks.some((c) => c.level === "warn")) return "warn";
  // "unknown" outranks "ok": if anything is unassessed, the headline must not
  // claim everything is fine.
  if (checks.some((c) => c.level === "unknown")) return "unknown";
  return "ok";
}

export function headline(level: Level): string {
  switch (level) {
    case "ok":
      return "Everything is working.";
    case "warn":
      return "Working, with something worth a look.";
    case "bad":
      return "Something is broken — your charts may not be current.";
    case "unknown":
      return "Working so far, but some things cannot be checked yet.";
  }
}
