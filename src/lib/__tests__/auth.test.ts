import test from "node:test";
import assert from "node:assert/strict";
import {
  authState,
  passwordMatches,
  requestAllowed,
  signToken,
  verifyToken,
} from "../auth";

const SECRET = "a-long-dashboard-password";
const NOW = 1_800_000_000;
const LATER = NOW + 3600;

test("a freshly minted token verifies", () => {
  assert.equal(verifyToken(SECRET, signToken(SECRET, LATER), NOW), true);
});

test("an expired token does not", () => {
  assert.equal(verifyToken(SECRET, signToken(SECRET, NOW - 1), NOW), false);
});

test("a token signed with another password does not verify", () => {
  // Changing APP_PASSWORD must log everyone out. That is the whole revocation
  // story, so it needs a test rather than an assumption.
  assert.equal(verifyToken(SECRET, signToken("different-password", LATER), NOW), false);
});

// The expiry travels in the clear, so the obvious attack is to rewrite it and
// keep the signature. The signature must be checked against the claimed expiry.
test("extending the expiry invalidates the signature", () => {
  const token = signToken(SECRET, NOW - 1);
  const forged = `${NOW + 99999}.${token.slice(token.lastIndexOf(".") + 1)}`;
  assert.equal(verifyToken(SECRET, forged, NOW), false);
});

test("malformed and empty tokens are refused, not crashed on", () => {
  for (const bad of [undefined, "", ".", "abc", "9999999999.", ".deadbeef", "not.a.token"]) {
    assert.equal(verifyToken(SECRET, bad, NOW), false, `accepted: ${String(bad)}`);
  }
});

test("password comparison rejects the empty password", () => {
  // Otherwise an unset field would match an unset secret and open the door.
  assert.equal(passwordMatches(SECRET, ""), false);
  assert.equal(passwordMatches("", ""), false);
  assert.equal(passwordMatches(SECRET, SECRET), true);
  assert.equal(passwordMatches(SECRET, SECRET + "x"), false);
});

test("a configured password means a session is required", () => {
  const state = authState({ APP_PASSWORD: SECRET, NODE_ENV: "production" } as NodeJS.ProcessEnv);
  assert.equal(state.mode, "required");
  assert.equal(requestAllowed(state, undefined, NOW), false);
  assert.equal(requestAllowed(state, signToken(SECRET, LATER), NOW), true);
});

// The bug this file exists to fix: nothing configured, everything served.
test("no password in production refuses every request", () => {
  const state = authState({ NODE_ENV: "production" } as NodeJS.ProcessEnv);
  assert.equal(state.mode, "misconfigured");
  assert.equal(requestAllowed(state, undefined, NOW), false);
  assert.equal(requestAllowed(state, signToken(SECRET, LATER), NOW), false);
});

test("whitespace is not a password", () => {
  assert.equal(authState({ APP_PASSWORD: "   ", NODE_ENV: "production" } as NodeJS.ProcessEnv).mode, "misconfigured");
});

test("development without a password stays open, so dev still works", () => {
  const state = authState({ NODE_ENV: "development" } as NodeJS.ProcessEnv);
  assert.equal(state.mode, "open");
  assert.equal(requestAllowed(state, undefined, NOW), true);
});
