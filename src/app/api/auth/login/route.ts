import { NextRequest, NextResponse } from "next/server";
import * as client from "openid-client";
import { getOidcConfig, redirectUri, SCOPES } from "@/lib/oidc";

export const runtime = "nodejs";

// Starts the OIDC flow: generates PKCE + state, stashes them in short-lived
// cookies, and redirects to the identity provider.
export async function GET(req: NextRequest) {
  try {
    const config = await getOidcConfig();

    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);
    const state = client.randomState();

    const url = client.buildAuthorizationUrl(config, {
      redirect_uri: redirectUri(req),
      scope: SCOPES,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      state
    });

    const res = NextResponse.redirect(url.href);
    // Needed only for the round trip to the provider and back.
    const opts = {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax" as const,
      path: "/",
      maxAge: 600 // 10 minutes
    };
    res.cookies.set("om_pkce", codeVerifier, opts);
    res.cookies.set("om_state", state, opts);
    // Where to land after signing in.
    const next = req.nextUrl.searchParams.get("next");
    if (next && next.startsWith("/")) res.cookies.set("om_next", next, opts);
    return res;
  } catch (err) {
    const msg = err instanceof Error ? err.message : "unknown error";
    console.error("login error:", msg);
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(msg)}`, req.nextUrl.origin)
    );
  }
}
