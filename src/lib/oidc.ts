// OpenID Connect client. Provider-agnostic: everything is read from the issuer's
// discovery document, so Microsoft Entra, Keycloak, Okta, Auth0 and others are a
// configuration change rather than a code change.
//
// Config (set in the environment — never committed):
//   OIDC_ISSUER         the issuer URL, e.g.
//                       https://login.microsoftonline.com/<tenant-id>/v2.0
//   OIDC_CLIENT_ID      the application (client) id
//   OIDC_CLIENT_SECRET  the client secret
//   AUTH_SECRET         random string, 32+ chars, signs the session cookie
//   AUTH_URL            this app's base URL, e.g. https://oneminute-nu.vercel.app
//                       (optional — inferred from the request when absent)
//
// The redirect URI registered with the provider must be:
//   <AUTH_URL>/api/auth/callback
//
// SERVER-ONLY.

import * as client from "openid-client";

let cached: client.Configuration | null = null;

export function oidcConfigured(): boolean {
  return !!(
    process.env.OIDC_ISSUER &&
    process.env.OIDC_CLIENT_ID &&
    process.env.OIDC_CLIENT_SECRET &&
    process.env.AUTH_SECRET
  );
}

/** Discovers the provider's endpoints. Cached — discovery is a network call. */
export async function getOidcConfig(): Promise<client.Configuration> {
  if (cached) return cached;
  if (!oidcConfigured()) {
    throw new Error(
      "OIDC is not configured — set OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET and AUTH_SECRET."
    );
  }
  cached = await client.discovery(
    new URL(process.env.OIDC_ISSUER!),
    process.env.OIDC_CLIENT_ID!,
    process.env.OIDC_CLIENT_SECRET!
  );
  return cached;
}

/** This app's base URL — explicit config wins, else inferred from the request. */
export function baseUrl(req: Request): string {
  const configured = process.env.AUTH_URL?.replace(/\/+$/, "");
  if (configured) return configured;
  const url = new URL(req.url);
  // Behind a proxy (Vercel), trust the forwarded host/proto.
  const host = req.headers.get("x-forwarded-host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}

export function redirectUri(req: Request): string {
  return `${baseUrl(req)}/api/auth/callback`;
}

// Scopes: openid is required; profile and email give us a name and address to
// match the user against our own records.
export const SCOPES = "openid profile email";
