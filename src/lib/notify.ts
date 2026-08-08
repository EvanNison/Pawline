import { Resend } from "resend";
import nodemailer from "nodemailer";
import { sql } from "./db";
import { metric as metricDef } from "./metrics";
import { format, type UnitSystem } from "./units";
import { reveal } from "./secrets";

/**
 * Sending alerts.
 *
 * Two channels, because for a single person emailing themselves the obvious
 * answer is their own mailbox. Gmail wins on the things that actually matter
 * here: no third-party account, and Gmail-to-Gmail delivery lands in the inbox
 * rather than in spam, which a shared third-party sending domain often does not.
 * Resend stays supported for anyone already using it, or sending to an address
 * they do not control.
 */
export type Channel = "gmail" | "resend" | "none";

interface GmailConfig {
  kind: "gmail";
  user: string;
  /**
   * A Google App Password. Revocable without changing the account password,
   * but not narrowly scoped: Google describes it as granting access to the
   * Google account, so it is stored and handled as a real credential.
   */
  appPassword: string;
  to: string;
}
interface ResendConfig {
  kind: "resend";
  key: string;
  to: string;
  from: string;
}
type Config = GmailConfig | ResendConfig | null;

async function emailConfig(): Promise<Config> {
  const rows = await sql()`select key, value from app_config
    where key in ('gmail_user','gmail_app_password','resend_api_key','alert_email')`;
  const db = Object.fromEntries(rows.map((r) => [r.key as string, r.value as string]));

  const to = process.env.ALERT_EMAIL || db.alert_email;
  if (!to) return null;

  // Gmail first: if it is set up, it is the better path.
  const gmailUser = process.env.GMAIL_USER || db.gmail_user;
  const storedPass = process.env.GMAIL_APP_PASSWORD || db.gmail_app_password;
  if (gmailUser && storedPass) {
    const opened = await reveal(storedPass);
    if (!opened.ok) {
      console.error("[notify] gmail credential unusable:", opened.reason);
      return null;
    }
    return { kind: "gmail", user: gmailUser, appPassword: opened.value, to };
  }

  const storedKey = process.env.RESEND_API_KEY || db.resend_api_key;
  if (storedKey) {
    const openedKey = await reveal(storedKey);
    if (!openedKey.ok) {
      console.error("[notify] resend credential unusable:", openedKey.reason);
      return null;
    }
    return {
      kind: "resend",
      key: openedKey.value,
      to,
      from: process.env.ALERT_FROM || "Pawline <onboarding@resend.dev>",
    };
  }
  return null;
}

/** Whether an email channel is configured at all, and which. */
export async function emailChannel(): Promise<Channel> {
  const cfg = await emailConfig();
  return cfg ? cfg.kind : "none";
}

export async function isEmailConfigured(): Promise<boolean> {
  return (await emailConfig()) !== null;
}

export async function sendEmail(subject: string, html: string): Promise<boolean> {
  const cfg = await emailConfig();
  if (!cfg) return false;

  try {
    if (cfg.kind === "gmail") {
      const transport = nodemailer.createTransport({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: { user: cfg.user, pass: cfg.appPassword.replace(/\s+/g, "") },
      });
      // Google shows app passwords in groups of four; people paste them that
      // way, and the spaces are not part of the secret.
      await transport.sendMail({ from: cfg.user, to: cfg.to, subject, html });
      return true;
    }

    const resend = new Resend(cfg.key);
    // Resend reports rejections in the response body rather than throwing, so
    // discarding the result marked bounced, rate-limited, quota-exceeded and
    // invalid-key sends as delivered — and the weekly digest then recorded
    // itself as sent and never retried.
    const res = await resend.emails.send({ from: cfg.from, to: cfg.to, subject, html });
    if (res.error) {
      console.error("[notify] resend rejected:", res.error);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[notify] ${cfg.kind} send failed:`, e);
    return false;
  }
}

/**
 * An alert as stored. Emails are rendered from these rather than from the
 * in-memory findings of the current run, so an alert whose send failed can be
 * retried later with its real figures intact.
 */
export interface AlertRecord {
  id: number;
  date: string;
  metric: string;
  direction: string;
  value: number | null;
  baseline_median: number | null;
  severity: string;
  days_outside: number | null;
  note: string | null;
  /** The condition has since cleared — say so rather than implying it is live. */
  resolved?: boolean;
}

export function renderAlertLine(a: AlertRecord, units: UnitSystem = "metric"): string {
  const past = a.resolved ? " — has since returned to normal" : "";
  // Absolute-threshold and operational alerts carry their own explanation;
  // there is no baseline to compare against.
  if (a.note) return `<li><b>${a.note}</b> <i>(${a.date})</i>${past}</li>`;

  const def = metricDef(a.metric);
  const label = def?.label ?? a.metric;
  // Values are stored canonically; an email quoting grams to someone who reads
  // kilograms is the same contradiction as a chart with a mismatched band.
  const show = (v: number | null) =>
    v === null ? "—" : def ? format(v, def.dimension, units) : v.toFixed(1);
  // format() already carries the unit; a second one left "74 /min  vs." with a
  // double space in the one message people actually read.
  const value = show(a.value);
  const usual = show(a.baseline_median);
  const days = a.days_outside ? `${a.days_outside} of the last 3 days, ` : "";
  return `<li><b>${label}</b> was ${a.direction} — ${value} vs. usual ${usual} (${days}severity: ${a.severity}) <i>on ${a.date}</i>${past}</li>`;
}

/**
 * Where this deployment lives, for a link back from the email.
 *
 * Vercel sets the production domain; self-hosted deployments set neither, and
 * then no link is offered rather than a broken one. An alert read on a phone
 * that says "open the dashboard" without saying where is asking someone to go
 * and find a URL they may never have memorised.
 */
export function dashboardUrl(env: Record<string, string | undefined> = process.env): string | null {
  const host = env.APP_URL || env.VERCEL_PROJECT_PRODUCTION_URL || env.VERCEL_URL;
  if (!host) return null;
  return /^https?:\/\//.test(host) ? host : `https://${host}`;
}

/**
 * Email the given stored alerts. Returns whether the send succeeded, so the
 * caller marks exactly these rows as notified — and only on success.
 */
export async function sendAlertEmail(petName: string, alerts: AlertRecord[], units: UnitSystem = "metric") {
  if (alerts.length === 0) return { sent: false };
  const lines = alerts.map((a) => renderAlertLine(a, units));
  const url = dashboardUrl();
  const link = url
    ? `<a href="${url}">Open ${petName}'s dashboard</a> for the charts.`
    : "Open your dashboard for the charts.";
  const sent = await sendEmail(
    `🐾 ${petName}: ${alerts.length} health ${alerts.length === 1 ? "alert" : "alerts"}`,
    `<p>${petName}'s recent readings have shifted away from their baseline:</p>` +
      `<ul>${lines.join("")}</ul>` +
      `<p>Not a diagnosis — a nudge to look closer. ${link}</p>`
  );
  return { sent };
}
