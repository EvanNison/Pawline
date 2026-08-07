import { test } from "node:test";
import assert from "node:assert/strict";
import { KNOWN_SOURCES, TRACTIVE_SOURCE_INFO, sourceInfo } from "../sources/registry";

/**
 * The gate in front of the vendor adapter. These assert the *contract* — that
 * risk is declared and the advisory says what it must — without needing a
 * database.
 */

test("every source declares its risk", () => {
  for (const s of KNOWN_SOURCES) {
    assert.ok(["none", "vendor-terms", "experimental"].includes(s.risk), `${s.id}: ${s.risk}`);
    assert.ok(s.description.trim().length > 0, `${s.id} has no description`);
  }
});

test("a risky source carries an advisory; a safe one needs none", () => {
  for (const s of KNOWN_SOURCES) {
    if (s.risk !== "none") {
      assert.ok(s.advisory && s.advisory.trim().length > 0, `${s.id} is risky but says nothing`);
    }
  }
  assert.equal(sourceInfo("csv")!.risk, "none");
});

test("the Tractive advisory quotes the term it is warning about", () => {
  const a = TRACTIVE_SOURCE_INFO.advisory!;
  // Paraphrasing a contract term into vagueness is how a warning stops
  // working. The user must see the actual sentence.
  assert.match(a, /5\.8/, "cites the section");
  assert.match(a, /automated access/, "quotes the operative phrase");
  assert.match(a, /without notice/, "states the consequence");
  assert.match(a, /no refund|cannot be made/, "states there is no refund");
  assert.match(a, /not affiliated/, "disclaims affiliation");
  assert.match(a, /your decision|your call/i, "leaves the choice with the reader");
  assert.match(a, /Data Act/, "points to the lower-risk alternative");
});

test("the advisory does not soften the risk with reassurance", () => {
  const a = TRACTIVE_SOURCE_INFO.advisory!.toLowerCase();
  for (const weasel of ["unlikely", "in practice", "nobody has", "probably fine", "low risk"]) {
    assert.ok(!a.includes(weasel), `advisory softens the risk with "${weasel}"`);
  }
});
