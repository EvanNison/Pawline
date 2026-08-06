import { test } from "node:test";
import assert from "node:assert/strict";
import { CANONICAL, format, toCanonical, toDisplay, unitLabel } from "../units";

test("canonical units are SI and do not vary by user", () => {
  assert.equal(CANONICAL.mass, "g");
  assert.equal(CANONICAL.distance, "m");
});

test("mass converts both ways", () => {
  // A ~32 lb dog is about 14.5 kg.
  const grams = 14515;
  assert.equal(toDisplay(grams, "mass", "imperial"), 32.0);
  assert.equal(toDisplay(grams, "mass", "metric"), 14.52);
  assert.equal(unitLabel("mass", "metric"), "kg");
});

test("distance converts both ways", () => {
  const meters = 5000;
  assert.equal(toDisplay(meters, "distance", "metric"), 5);
  assert.equal(toDisplay(meters, "distance", "imperial"), 3.11);
});

test("round-trip through display and back preserves the value", () => {
  for (const dim of ["mass", "distance"] as const) {
    for (const system of ["metric", "imperial"] as const) {
      const canonical = 12345.6;
      const back = toCanonical(toDisplay(canonical, dim, system), dim, system);
      // Only display rounding should be lost.
      assert.ok(Math.abs(back - canonical) < 10, `${dim}/${system}: ${back} vs ${canonical}`);
    }
  }
});

test("unit-free dimensions are identical in both systems AND unchanged", () => {
  // Comparing the two systems alone would pass if BOTH doubled the value.
  for (const dim of ["duration", "rate", "energy", "count", "score", "percent"] as const) {
    assert.equal(toDisplay(42, dim, "metric"), 42, dim);
    assert.equal(toDisplay(42, dim, "imperial"), 42, dim);
  }
});

test("a short duration is not rounded away to nothing", () => {
  // 20 seconds of scratching is 0.33 minutes. Rounding to whole minutes showed
  // it as "0 min", and 30 seconds as "1 min" — nothing, or double.
  assert.equal(toDisplay(20 / 60, "duration", "metric"), 0.3);
  assert.equal(toDisplay(30 / 60, "duration", "metric"), 0.5);
  assert.match(format(20 / 60, "duration", "metric"), /^0\.3 min$/);
});

test("format renders a labelled string", () => {
  assert.equal(format(14515, "mass", "imperial"), "32.0 lb");
  assert.equal(format(14515, "mass", "metric"), "14.52 kg");
  assert.equal(format(62, "rate", "metric"), "62 /min");
  assert.equal(format(85, "score", "metric"), "85", "score carries no unit suffix");
});

test("zero and negative values are handled", () => {
  assert.equal(toDisplay(0, "mass", "imperial"), 0);
  assert.equal(format(0, "distance", "metric"), "0.00 km");
  // The name promised negatives; now it actually supplies them. A negative
  // reading is nonsense for these metrics, but the converter must not mangle
  // one into a plausible positive.
  assert.ok(toDisplay(-14515, "mass", "imperial") < 0);
  assert.equal(toDisplay(-1000, "distance", "metric"), -1);
  assert.match(format(-1000, "distance", "metric"), /^-1\.00 km$/);
});
