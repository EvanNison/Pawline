import { test } from "node:test";
import assert from "node:assert/strict";
import { REGISTRY, availableMetrics, isKnownMetric, metric } from "../metrics";
import { CANONICAL, type Dimension } from "../units";

/**
 * The registry is the contract every adapter maps into. A wrong dimension,
 * direction or species flag here silently mis-scales or mis-judges a chart a
 * vet reads, and nothing else in the codebase would notice.
 */

test("keys are unique and unit-free", () => {
  const keys = REGISTRY.map((m) => m.key);
  assert.equal(new Set(keys).size, keys.length, "duplicate metric key");
  for (const k of keys) {
    // A key naming a unit invites storing a different one — exactly how
    // weight_lb and distance_mi went wrong in the predecessor.
    assert.doesNotMatch(k, /_(lb|lbs|kg|mi|km|g|m|sec|seconds|hours|hrs)$/, `"${k}" names a unit`);
  }
});

test("every metric declares a dimension the units module knows", () => {
  for (const m of REGISTRY) {
    assert.ok(m.dimension in CANONICAL, `${m.key} has unknown dimension "${m.dimension}"`);
    assert.ok(m.label.trim().length > 0, `${m.key} has no label`);
    assert.ok(m.species.length > 0, `${m.key} applies to no species`);
  }
});

test("directions match what is actually concerning for each metric", () => {
  // Getting one of these backwards inverts an alert: it would fire on recovery
  // and stay silent on deterioration.
  const expected: Record<string, string> = {
    resting_heart_rate: "both",
    resting_respiratory_rate: "both",
    sleep_score: "low_bad",
    night_sleep_minutes: "low_bad",
    sleep_interruptions: "high_bad",
    active_minutes: "low_bad",
    scratching: "high_bad",
    barking_events: "high_bad",
    wear_time: "low_bad",
    weight: "both",
  };
  for (const [key, dir] of Object.entries(expected)) {
    assert.equal(metric(key)?.direction, dir, `${key} has the wrong direction`);
  }
});

test("dimensions match the quantity each metric measures", () => {
  const expected: Record<string, Dimension> = {
    resting_heart_rate: "rate",
    resting_respiratory_rate: "rate",
    weight: "mass",
    distance: "distance",
    active_minutes: "duration",
    night_sleep_minutes: "duration",
    scratching: "duration",
    wear_time: "duration",
    calories: "energy",
    sleep_interruptions: "count",
    barking_events: "count",
    sleep_score: "score",
  };
  for (const [key, dim] of Object.entries(expected)) {
    assert.equal(metric(key)?.dimension, dim, `${key} has the wrong dimension`);
  }
});

test("bark detection is not offered for cats", () => {
  assert.deepEqual(metric("barking_events")?.species, ["dog"]);
  const catMetrics = availableMetrics("cat", REGISTRY.map((m) => m.key));
  assert.ok(!catMetrics.some((m) => m.key === "barking_events"));
  assert.ok(catMetrics.some((m) => m.key === "resting_heart_rate"), "cats still get vitals");
});

test("availableMetrics gates on hardware as well as species", () => {
  const basic = availableMetrics("dog", ["active_minutes"]);
  assert.deepEqual(basic.map((m) => m.key), ["active_minutes"]);
  assert.equal(availableMetrics("dog", []).length, 0, "a tracker reporting nothing shows nothing");
  // Unknown species falls back to showing whatever the hardware supports.
  assert.ok(availableMetrics("unknown", ["barking_events"]).some((m) => m.key === "barking_events"));
});

test("the metrics worth alerting on are the ones a vet would act on", () => {
  const alerting = REGISTRY.filter((m) => m.alert).map((m) => m.key).sort();
  assert.deepEqual(alerting, [
    "active_minutes",
    "night_sleep_minutes",
    "resting_heart_rate",
    "resting_respiratory_rate",
    "scratching",
    "sleep_interruptions",
    "sleep_score",
    "weight",
  ]);
  // Wear time explains other metrics; alerting on it directly is noise.
  assert.equal(metric("wear_time")?.alert, false);
});

test("isKnownMetric is the gate adapters are held to", () => {
  assert.equal(isKnownMetric("resting_heart_rate"), true);
  assert.equal(isKnownMetric("weight_lb"), false, "a unit-bearing key must not resolve");
  assert.equal(isKnownMetric("made_up"), false);
  assert.equal(isKnownMetric(""), false);
});
