import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";

export const runtime = "nodejs";

// Clears the local session. The provider's own session is left alone — single
// sign-out would send the user to the IdP's end_session endpoint, which is not
// what most people expect from a "sign out of this app" button.
export async function POST(req: NextRequest) {
  const res = NextResponse.redirect(new URL("/login", req.nextUrl.origin));
  res.cookies.delete(SESSION_COOKIE);
  return res;
}

export async function GET(req: NextRequest) {
  return POST(req);
}
