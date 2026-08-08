import { test } from "node:test";
import assert from "node:assert/strict";
import { toStringArray } from "../store";
import { availableMetrics } from "../metrics";

/**
 * The bug this guards against was invisible to every other test.
 *
 * The driver returns jsonb as a string. `capabilities as string[]` was a
 * compile-time cast over that, so `new Set(capabilities)` became a set of single
 * characters and no metric key ever matched. Every dashboard showed a pet name,
 * "not enough history", and no charts — from any source, forever.
 */
test("a jsonb array arriving as a string becomes a real array", () => {
  assert.deepEqual(toStringArray('["resting_heart_rate","weight"]'), [
    "resting_heart_rate",
    "weight",
  ]);
});

test("an already-parsed array passes through unchanged", () => {
  // A driver or config that does parse jsonb must keep working.
  assert.deepEqual(toStringArray(["a", "b"]), ["a", "b"]);
});

test("null, undefined and malformed json yield an empty array, not a crash", () => {
  for (const bad of [null, undefined, "", "not json", "{}", '{"a":1}', 42]) {
    assert.deepEqual(toStringArray(bad), [], `failed on ${JSON.stringify(bad)}`);
  }
});

// The actual consequence, stated as a test: this is what broke.
test("capabilities read from storage select the metrics they name", () => {
  const stored = '["resting_heart_rate","night_sleep_minutes","weight"]';
  const shown = availableMetrics("unknown", toStringArray(stored));
  assert.deepEqual(
    shown.map((m) => m.key).sort(),
    ["night_sleep_minutes", "resting_heart_rate", "weight"]
  );

  // And the shape of the failure: the raw string selects nothing at all.
  assert.equal(
    availableMetrics("unknown", stored as unknown as string[]).length,
    0,
    "passing the raw string must select no metrics — that was the bug"
  );
});
