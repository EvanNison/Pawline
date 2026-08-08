/**
 * Tests for what the alert email actually says.
 *
 * This is the only part of the app most people read, and usually on a phone,
 * so its wording and units matter as much as the detection behind it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dashboardUrl, renderAlertLine } from "../notify";

// The email is the only part of this app most people will read on a phone.
test("a rendered line carries the unit exactly once", () => {
  const line = renderAlertLine(
    { id: 1, date: "2026-08-08", metric: "resting_heart_rate", direction: "high",
      value: 74, baseline_median: 61, severity: "alert", days_outside: 3, note: null, resolved: false },
    "metric"
  );
  assert.match(line, /74 \/min vs\. usual 61 \/min/);
  assert.doesNotMatch(line, /  /, "no doubled spaces from a stray unit");
});

test("values are shown in the reader's units, not canonical storage", () => {
  // 14600 g stored; an email quoting grams to someone who reads pounds is the
  // same contradiction as a chart whose band uses different units to its line.
  const line = renderAlertLine(
    { id: 1, date: "2026-08-08", metric: "weight", direction: "low",
      value: 14600, baseline_median: 15200, severity: "watch", days_outside: 2, note: null, resolved: false },
    "imperial"
  );
  assert.match(line, /32\.2 lb/);
  assert.doesNotMatch(line, /14600/);
});

test("a resolved alert says so rather than reading as live", () => {
  const line = renderAlertLine(
    { id: 1, date: "2026-08-01", metric: "active_minutes", direction: "low",
      value: 10, baseline_median: 90, severity: "watch", days_outside: 2, note: null, resolved: true },
    "metric"
  );
  assert.match(line, /has since returned to normal/);
});

test("the dashboard link is offered only when a host is actually known", () => {
  // A link to nowhere is worse than no link: it reads as the app being broken.
  assert.equal(dashboardUrl({}), null);
  assert.equal(dashboardUrl({ VERCEL_URL: "x.vercel.app" }), "https://x.vercel.app");
  assert.equal(
    dashboardUrl({ VERCEL_PROJECT_PRODUCTION_URL: "pawline.vercel.app", VERCEL_URL: "deploy-xyz.vercel.app" }),
    "https://pawline.vercel.app",
    "the stable production domain wins over a per-deployment URL"
  );
  assert.equal(dashboardUrl({ APP_URL: "https://pets.example.com" }), "https://pets.example.com");
});
