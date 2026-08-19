// Auth backed by OpenID Connect.
//
// The two functions below are the ONLY way the rest of the app learns who is
// signed in — 30+ files call them and none of them know or care which identity
// provider is behind it. Swapping providers means changing this file and the
// routes under /api/auth, nothing else.
//
// IDENTITY, AND WHY IT MATTERS:
// meetings.owner_user_id and minutes.assigned_to_user_id reference User.id. Those
// ids were originally issued by Supabase Auth. A new provider issues different
// subject ids, so we deliberately DO NOT use the OIDC subject as User.id —
// instead we match the person by EMAIL and keep whatever id they already have.
// The OIDC subject is stored in entraObjectId for reference. Without this, every
// existing task assignment would point at a user that no longer exists.
//
// SERVER-ONLY.

import { randomUUID } from "crypto";
import { db } from "@/lib/db";
import { getSession } from "@/lib/session";

// The single org everyone joins until org onboarding is built.
const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001";

export interface AppUser {
  id: string; // our User.id — stable across an identity-provider change
  orgId: string;
  email: string;
  displayName: string;
}

/** Returns the current app user, or null if not signed in. Provisions on first login. */
export async function getCurrentUser(): Promise<AppUser | null> {
  const session = await getSession();
  if (!session) return null;

  const email = (session.email || "").trim().toLowerCase();
  if (!email) return null; // no email claim -> we cannot match a person safely

  // Match on email, NOT on the provider's subject id — see the note above.
  let dbUser = await db.user.findUnique({ where: { email } });

  if (dbUser) {
    // Record the provider subject the first time we see it, so the link is
    // visible later. The id itself is never changed.
    if (!dbUser.entraObjectId && session.sub) {
      dbUser = await db.user.update({
        where: { id: dbUser.id },
        data: { entraObjectId: session.sub }
      });
    }
  } else {
    // First time this person has signed in — provision them.
    await db.org.upsert({
      where: { id: DEFAULT_ORG_ID },
      update: {},
      create: { id: DEFAULT_ORG_ID, name: "3TT" }
    });

    dbUser = await db.user.create({
      data: {
        // A fresh id of our own, so we are never coupled to a provider's id
        // scheme again.
        id: randomUUID(),
        orgId: DEFAULT_ORG_ID,
        email,
        displayName: session.name?.trim() || email.split("@")[0],
        entraObjectId: session.sub || null
      }
    });
  }

  return {
    id: dbUser.id,
    orgId: dbUser.orgId,
    email: dbUser.email,
    displayName: dbUser.displayName
  };
}

/** Throws if not signed in. Use in API routes / server actions that require auth. */
export async function requireUser(): Promise<AppUser> {
  const user = await getCurrentUser();
  if (!user) throw new Error("UNAUTHENTICATED");
  return user;
}
