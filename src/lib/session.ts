// The signed session cookie that replaces Supabase's session handling.
//
// A small JWT signed with AUTH_SECRET, holding only what is needed to identify
// the person: the OIDC subject, their email, and a display name. Everything else
// (org, roster status) is read from our own database on each request, so a stale
// cookie can never carry stale authorisation.
//
// SERVER-ONLY.

import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "om_session";
const MAX_AGE_SECONDS = 60 * 60 * 8; // 8 hours — a working day

export interface SessionClaims {
  sub: string; // the OIDC subject (stable per user, per issuer)
  email: string;
  name: string;
}

function secret(): Uint8Array {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 32) {
    throw new Error(
      "AUTH_SECRET is missing or too short — set a random string of at least 32 characters."
    );
  }
  return new TextEncoder().encode(s);
}

export async function createSession(claims: SessionClaims): Promise<string> {
  return new SignJWT({ email: claims.email, name: claims.name })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secret());
}

export async function readSession(token: string | undefined): Promise<SessionClaims | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret());
    if (!payload.sub) return null;
    return {
      sub: payload.sub,
      email: String(payload.email ?? ""),
      name: String(payload.name ?? "")
    };
  } catch {
    // Expired, tampered with, or signed with a different secret.
    return null;
  }
}

/** The session for the current request, or null when signed out. */
export async function getSession(): Promise<SessionClaims | null> {
  const jar = await cookies();
  return readSession(jar.get(SESSION_COOKIE)?.value);
}

export function cookieOptions() {
  return {
    httpOnly: true, // never readable from JavaScript
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const, // survives the redirect back from the IdP
    path: "/",
    maxAge: MAX_AGE_SECONDS
  };
}
