/**
 * The dashboard password.
 *
 * SETUP.md promises "a private website only you can open". Until this existed
 * that was simply untrue: every page and both credential-writing Server Actions
 * were reachable by anyone with the URL, and the promise made people *less*
 * careful with a link than they would otherwise have been.
 *
 * Two layers, because one is not enough. Proxy redirects unauthenticated
 * requests, and every page and Server Action re-checks. Next's own guidance is
 * explicit that Proxy "should not be your only line of defense" and that Server
 * Actions must be treated as public endpoints — they are separate entry points
 * and are not covered by a page-level check.
 *
 * The pure functions below take the secret as an argument so they can be tested
 * without a request, a cookie store, or an environment.
 */

import { createHmac, timingSafeEqual } from "crypto";

export const SESSION_COOKIE = "pawline_session";
/** Long enough not to nag a household; short enough that a stale device lapses. */
export const SESSION_DAYS = 30;

/**
 * Mint a session token: the expiry, plus an HMAC of it under the password.
 *
 * Deriving the key from APP_PASSWORD means changing the password invalidates
 * every existing session, with no revocation list to maintain — the property
 * you actually want the moment you suspect the link has spread.
 */
export function signToken(secret: string, expiresAtEpoch: number): string {
  const exp = String(Math.floor(expiresAtEpoch));
  return `${exp}.${createHmac("sha256", secret).update(`session:${exp}`).digest("hex")}`;
}

/** Constant-time compare that never throws on a length mismatch. */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function verifyToken(secret: string, token: string | undefined, nowEpoch: number): boolean {
  if (!token) return false;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return false;
  const exp = Number(token.slice(0, dot));
  // Check the signature before trusting the expiry: the expiry is attacker-
  // supplied until the HMAC says otherwise.
  if (!safeEqual(token, signToken(secret, exp))) return false;
  return Number.isFinite(exp) && exp > nowEpoch;
}

/** Whether the submitted password is the configured one. */
export function passwordMatches(secret: string, submitted: string): boolean {
  return submitted.length > 0 && safeEqual(secret, submitted);
}

export type AuthState =
  /** A password is set; a valid session is required. */
  | { mode: "required"; secret: string }
  /** No password, and not production: local development, open on purpose. */
  | { mode: "open" }
  /** No password in production. Refuse to serve rather than expose the data. */
  | { mode: "misconfigured" };

/**
 * Decide what protection applies, from configuration alone.
 *
 * Missing configuration in production is treated as a fault, not as permission.
 * The alternative — serve everything because nothing was set — is precisely the
 * bug this file exists to fix, and it fails silently and invisibly. This
 * mirrors the collect route, which already refuses to run without CRON_SECRET.
 */
export function authState(env: NodeJS.ProcessEnv = process.env): AuthState {
  const secret = (env.APP_PASSWORD ?? "").trim();
  if (secret.length > 0) return { mode: "required", secret };
  return env.NODE_ENV === "production" ? { mode: "misconfigured" } : { mode: "open" };
}

/** Whether this request may proceed, given its cookie. */
export function requestAllowed(
  state: AuthState,
  token: string | undefined,
  nowEpoch: number
): boolean {
  if (state.mode === "open") return true;
  if (state.mode === "misconfigured") return false;
  return verifyToken(state.secret, token, nowEpoch);
}
