/**
 * The outer net. Redirects unauthenticated requests before a page renders.
 *
 * Deliberately not the only check — Next's guidance is that Proxy "should not
 * be your only line of defense", and Server Actions are separate entry points
 * it does not meaningfully protect. Every page and action calls
 * `requireSession()` too. This layer exists so that forgetting one of those is
 * a redundancy failure rather than a data leak.
 *
 * Since Next.js 16 this file is `proxy.ts`; it was `middleware.ts` before.
 */

import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, authState, requestAllowed } from "@/lib/auth";

export function proxy(request: NextRequest): NextResponse {
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  if (requestAllowed(authState(), token, Math.floor(Date.now() / 1000))) {
    return NextResponse.next();
  }
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = authState().mode === "misconfigured" ? "?status=misconfigured" : "";
  return NextResponse.redirect(url);
}

export const config = {
  /**
   * Everything except the sign-in page itself, the collect endpoint (which
   * authenticates with CRON_SECRET, not a browser session), and static assets.
   *
   * Written as an exclusion rather than a list of protected paths: a new page
   * must then be *deliberately* exempted, instead of being unprotected because
   * someone forgot to add it.
   */
  matcher: ["/((?!login|api/collect|_next/static|_next/image|favicon.ico).*)"],
};
