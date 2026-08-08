/**
 * Tests for the status page's assessment logic.
 *
 * The governing rule is that absence of evidence must never be reported as good
 * news — so most of these check that something is NOT "ok" rather than that it
 * is. The failure this page exists to catch looks like health.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStatus, headline, overallLevel, type Check, type StatusInput } from "../health";

const NOW = new Date("2026-08-20T12:00:00Z");
const TODAY = "2026-08-20";
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

function input(over: Partial<StatusInput> = {}): StatusInput {
  return {
    now: NOW,
    today: TODAY,
    lastRun: { startedAt: hoursAgo(6), finishedAt: hoursAgo(6), ok: true, error: null },
    lastSuccessAt: hoursAgo(6),
    metricFreshness: [{ metric: "resting_heart_rate", label: "Resting Heart Rate", newest: TODAY }],
    emailChannel: "gmail",
    undeliveredAlerts: 0,
    credentialsPresent: true,
    petCount: 1,
    ...over,
  };
}
const find = (checks: Check[], id: string) => checks.find((c) => c.id === id)!;

test("a healthy install reports ok", () => {
  const checks = buildStatus(input());
  assert.equal(overallLevel(checks), "ok");
  assert.equal(find(checks, "collection").level, "ok");
});

test("a stalled cron is loud, not silent", () => {
  // The whole point: collection stops, charts keep showing last month, and
  // nothing else on the site changes.
  const checks = buildStatus(input({ lastSuccessAt: hoursAgo(50), lastRun: { startedAt: hoursAgo(50), finishedAt: hoursAgo(50), ok: true, error: null } }));
  assert.equal(find(checks, "collection").level, "bad");
  assert.match(find(checks, "collection").detail, /charts are frozen/);
  assert.equal(overallLevel(checks), "bad");
});

test("one missed run warns before it becomes a failure", () => {
  const checks = buildStatus(input({ lastSuccessAt: hoursAgo(30) }));
  assert.equal(find(checks, "collection").level, "warn");
});

test("a run that started and never finished is caught", () => {
  // Invisible in every other signal: no snapshot, no alert, no chart change.
  const checks = buildStatus(
    input({ lastRun: { startedAt: hoursAgo(3), finishedAt: null, ok: null, error: null }, lastSuccessAt: hoursAgo(27) })
  );
  assert.equal(find(checks, "collection").level, "bad");
  assert.match(find(checks, "collection").detail, /never finished/);
});

test("a run in flight right now is not reported as stuck", () => {
  const checks = buildStatus(
    input({ lastRun: { startedAt: hoursAgo(0.2), finishedAt: null, ok: null, error: null } })
  );
  assert.notEqual(find(checks, "collection").level, "bad");
});

test("never having collected is unknown, not ok", () => {
  const checks = buildStatus(input({ lastRun: null, lastSuccessAt: null }));
  assert.equal(find(checks, "collection").level, "unknown");
  assert.notEqual(overallLevel(checks), "ok", "a fresh install must not claim everything works");
});

test("having tried and never succeeded is bad", () => {
  const checks = buildStatus(
    input({ lastRun: { startedAt: hoursAgo(2), finishedAt: hoursAgo(2), ok: false, error: "login failed" }, lastSuccessAt: null })
  );
  assert.equal(find(checks, "collection").level, "bad");
  assert.match(find(checks, "collection").detail, /login failed/);
});

test("a metric that quietly stopped arriving is caught even while collection succeeds", () => {
  // The nastiest failure shape: the run works, the page looks alive, and one
  // measurement has silently gone missing from the vendor payload.
  const checks = buildStatus(
    input({ metricFreshness: [{ metric: "respiratory_rate", label: "Resting Respiratory Rate", newest: "2026-08-01" }] })
  );
  assert.equal(find(checks, "metric:respiratory_rate").level, "bad");
  assert.match(find(checks, "metric:respiratory_rate").detail, /stopped arriving/);
  assert.equal(find(checks, "collection").level, "ok", "collection itself is fine — that is the point");
});

test("a metric with no readings at all is unknown, never ok", () => {
  const checks = buildStatus(
    input({ metricFreshness: [{ metric: "scratching", label: "Scratching", newest: null }] })
  );
  assert.equal(find(checks, "metric:scratching").level, "unknown");
});

test("a day or two of lag is tolerated, because vendor lookbacks heal it", () => {
  const checks = buildStatus(
    input({ metricFreshness: [{ metric: "sleep_score", label: "Sleep Score", newest: "2026-08-18" }] })
  );
  assert.equal(find(checks, "metric:sleep_score").level, "ok");
});

test("missing credentials are reported as the blocker they are", () => {
  const checks = buildStatus(input({ credentialsPresent: false }));
  assert.equal(find(checks, "credentials").level, "bad");
});

test("no email configured is a choice, not a fault", () => {
  const checks = buildStatus(input({ emailChannel: "none" }));
  assert.equal(find(checks, "email").level, "unknown");
  assert.match(find(checks, "email").detail, /will not be emailed/);
});

test("email configured but failing is a fault, because it hides alerts", () => {
  const checks = buildStatus(input({ undeliveredAlerts: 2 }));
  assert.equal(find(checks, "email").level, "bad");
  assert.match(find(checks, "email").detail, /2 alerts could not be emailed/);
});

// A Gmail user sent to check a Resend key goes looking for a setting they have
// never owned, and concludes the app is broken. The advice must match the route.
test("delivery failure names the route in use, and only that route", () => {
  const gmail = find(buildStatus(input({ emailChannel: "gmail", undeliveredAlerts: 1 })), "email");
  assert.match(gmail.detail, /Gmail/);
  assert.match(gmail.detail, /App Password/);
  assert.doesNotMatch(gmail.detail, /Resend/);

  const resend = find(buildStatus(input({ emailChannel: "resend", undeliveredAlerts: 1 })), "email");
  assert.match(resend.detail, /Resend/);
  assert.doesNotMatch(resend.detail, /App Password/);
});

// SETUP.md tells people the status page names the sending route. It has to.
test("a working route is named, so the page can be checked against the docs", () => {
  assert.match(find(buildStatus(input({ emailChannel: "gmail" })), "email").detail, /Gmail/);
  assert.match(find(buildStatus(input({ emailChannel: "resend" })), "email").detail, /Resend/);
});

test("the headline never claims health while anything is unassessed", () => {
  const mixed: Check[] = [
    { id: "a", label: "a", level: "ok", detail: "" },
    { id: "b", label: "b", level: "unknown", detail: "" },
  ];
  assert.equal(overallLevel(mixed), "unknown");
  assert.doesNotMatch(headline(overallLevel(mixed)), /Everything is working/);

  // ...and a real fault outranks an unknown.
  assert.equal(overallLevel([...mixed, { id: "c", label: "c", level: "bad", detail: "" }]), "bad");
  // ...and a warning outranks an unknown.
  assert.equal(overallLevel([...mixed, { id: "c", label: "c", level: "warn", detail: "" }]), "warn");
});

test("every check carries an actionable line, not just a colour", () => {
  const checks = buildStatus(input({ lastSuccessAt: hoursAgo(50), credentialsPresent: false, undeliveredAlerts: 1 }));
  for (const c of checks) {
    assert.ok(c.detail.trim().length > 0, `${c.id} has no explanation`);
    assert.ok(c.label.trim().length > 0);
  }
});
