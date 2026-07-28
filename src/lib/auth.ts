// Real auth backed by Supabase.
//
// On first login we provision a User row in our own DB (linked to the auth
// user's UID via entraObjectId/id) and attach them to the default org.
// Multi-org onboarding comes later; for now every new user joins DEV_ORG.

import { db } from "@/lib/db";
import { createClient } from "@/lib/supabase/server";

// The single org everyone joins until org onboarding is built.
const DEFAULT_ORG_ID = "00000000-0000-0000-0000-000000000001";

export interface AppUser {
  id: string;        // our User.id (same as Supabase auth uid)
  orgId: string;
  email: string;
  displayName: string;
}

/** Returns the current app user, or null if not signed in. Provisions on first call. */
export async function getCurrentUser(): Promise<AppUser | null> {
  const supabase = await createClient();
  const {
    data: { user }
  } = await supabase.auth.getUser();

  if (!user) return null;

  // Find existing DB user by auth uid.
  let dbUser = await db.user.findUnique({ where: { id: user.id } });

  if (!dbUser) {
    // Ensure the default org exists (idempotent).
    await db.org.upsert({
      where: { id: DEFAULT_ORG_ID },
      update: {},
      create: { id: DEFAULT_ORG_ID, name: "3TT" }
    });

    const email = user.email ?? `${user.id}@unknown.local`;
    const displayName =
      (user.user_metadata?.full_name as string | undefined) ||
      (user.user_metadata?.name as string | undefined) ||
      email.split("@")[0];

    dbUser = await db.user.upsert({
      where: { email },
      update: { id: user.id },
      create: {
        id: user.id,
        orgId: DEFAULT_ORG_ID,
        email,
        displayName,
        entraObjectId: (user.user_metadata?.provider_id as string | undefined) ?? null
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
