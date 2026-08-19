import { NextRequest, NextResponse } from "next/server";
import * as client from "openid-client";
import { getOidcConfig, redirectUri } from "@/lib/oidc";
import { createSession, SESSION_COOKIE, cookieOptions } from "@/lib/session";

export const runtime = "nodejs";

// The provider redirects here with a code. Exchange it, verify the id token, and
// mint our own session cookie. No user record is touched here — getCurrentUser()
// provisions from the session, so there is one place that owns that logic.
export async function GET(req: NextRequest) {
  const fail = (msg: string) =>
    NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(msg)}`, req.nextUrl.origin));

  try {
    const config = await getOidcConfig();

    const codeVerifier = req.cookies.get("om_pkce")?.value;
    const expectedState = req.cookies.get("om_state")?.value;
    if (!codeVerifier || !expectedState) {
      return fail("Sign-in expired — please try again.");
    }

    // Rebuild the URL the provider called us on, using the public host so the
    // redirect_uri matches what was registered.
    const current = new URL(req.url);
    const callback = new URL(redirectUri(req));
    callback.search = current.search;

    const tokens = await client.authorizationCodeGrant(config, callback, {
      pkceCodeVerifier: codeVerifier,
      expectedState
    });

    const claims = tokens.claims();
    if (!claims?.sub) return fail("The identity provider returned no subject.");

    // Entra puts the address in `email` or `preferred_username` depending on
    // configuration; accept either.
    const email = String(
      (claims as Record<string, unknown>).email ??
        (claims as Record<string, unknown>).preferred_username ??
        ""
    ).toLowerCase();
    if (!email) {
      return fail("No email address was returned — grant the 'email' scope to this app.");
    }
    const name = String(
      (claims as Record<string, unknown>).name ??
        (claims as Record<string, unknown>).given_name ??
        ""
    );

    const token = await createSession({ sub: String(claims.sub), email, name });

    const next = req.cookies.get("om_next")?.value;
    const dest = next && next.startsWith("/") ? next : "/browse";
    const res = NextResponse.redirect(new URL(dest, req.nextUrl.origin));
    res.cookies.set(SESSION_COOKIE, token, cookieOptions());
    // The round-trip cookies have done their job.
    for (const c of ["om_pkce", "om_state", "om_next"]) res.cookies.delete(c);
    return res;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "sign-in failed";
    console.error("oidc callback error:", msg);
    return fail(msg);
  }
}
