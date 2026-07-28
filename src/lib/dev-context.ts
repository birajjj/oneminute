// TEMPORARY: dev-only user/org context, used until real auth is wired.
// Every API route + Server Component reads identity from here.
// When Microsoft SSO ships, replace this file with a real getSession() call
// — nothing else in the codebase should need to change.

export const DEV_ORG_ID = "00000000-0000-0000-0000-000000000001";
export const DEV_USER_ID = "00000000-0000-0000-0000-000000000002";

export function currentOrgId(): string {
  return DEV_ORG_ID;
}

export function currentUserId(): string {
  return DEV_USER_ID;
}
