/**
 * The request-facing half of authentication: cookies, redirects, sign-in.
 *
 * Kept apart from `auth.ts` so the rules themselves stay testable without a
 * request context. Everything here is a thin wrapper over a pure function.
 */

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  SESSION_COOKIE,
  SESSION_DAYS,
  authState,
  passwordMatches,
  requestAllowed,
  signToken,
} from "./auth";

const nowEpoch = () => Math.floor(Date.now() / 1000);

/** Whether the current request carries a valid session. */
export async function isSignedIn(): Promise<boolean> {
  const store = await cookies();
  return requestAllowed(authState(), store.get(SESSION_COOKIE)?.value, nowEpoch());
}

/**
 * Guard for pages and Server Actions alike.
 *
 * Server Actions are separate entry points that a page-level check does not
 * cover, and Next's own guidance is to treat them as public endpoints. So this
 * is called at the top of every action as well as every page — the redundancy
 * with Proxy is the point.
 */
export async function requireSession(): Promise<void> {
  if (await isSignedIn()) return;
  redirect(authState().mode === "misconfigured" ? "/login?status=misconfigured" : "/login");
}

/** Verify a submitted password and, if it is right, start a session. */
export async function startSession(submitted: string): Promise<boolean> {
  const state = authState();
  if (state.mode !== "required" || !passwordMatches(state.secret, submitted)) return false;

  const exp = nowEpoch() + SESSION_DAYS * 24 * 3600;
  const store = await cookies();
  store.set(SESSION_COOKIE, signToken(state.secret, exp), {
    httpOnly: true, // never readable from JavaScript
    sameSite: "lax", // survives following a link in; blocks cross-site posts
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 3600,
  });
  return true;
}

export async function endSession(): Promise<void> {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
