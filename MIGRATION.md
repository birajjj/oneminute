# Moving off Supabase

Supabase is doing **two unrelated jobs** in this project. Separating them is the
whole point of this document, because only one of them is real work.

| Job | Coupled? | Effort |
|---|---|---|
| **Database** (Postgres) | No — already standard Postgres | Config only: 2 env vars |
| **Authentication** (login, sessions) | Yes | The actual migration |

The common assumption is that "Supabase" means the database, so moving to
Postgres sounds like a database task. It isn't. The database layer contains **no
Supabase-specific code at all** — every query goes through Prisma against
standard Postgres. What is tied to Supabase is *who is logged in*.

---

## Part 1 — The database: nothing to change

`prisma/schema.prisma`:

```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}
```

Nothing is hardcoded. No code calls a Supabase API for data — no `supabase.from()`,
no `.storage`, no `.rpc()`. All 33 files that touch data use Prisma.

### Steps

1. **Stand up Postgres** (17.x matches what is running today).
2. **Create the schema**, either from the checked-in schema:
   ```
   npx prisma db push
   ```
   or from a dump that carries the data with it:
   ```
   psql "<connection-string>" -f backups/dump-<timestamp>.sql
   ```
3. **Point the app at it** — set `DATABASE_URL` and `DIRECT_URL`.
   (`DIRECT_URL` exists for Prisma migrations, which must bypass a connection
   pooler. On a plain Postgres with no pooler, set both to the same value.)
4. **Verify before switching anything over:**
   ```
   node --env-file=.env scripts/check-db.js
   ```
   Confirms it connects, that it really is Postgres, that all 10 tables exist,
   and prints row counts to compare against the old database.

### Backups / moving the data

```
node --env-file=.env scripts/backup-db.js    # JSON, restore via restore-db.js
node --env-file=.env scripts/backup-sql.js   # .sql — schema + data, runs in psql
```

> **Postgres only.** The schema uses `text[]` arrays, enum types, `uuid` and
> `bytea`. None port to MySQL or SQL Server without redesigning the schema.

---

## Part 2 — Authentication: the real migration

### Files that touch Supabase

| File | Role |
|---|---|
| `src/lib/auth.ts` | **The seam.** `getCurrentUser()` / `requireUser()` |
| `src/lib/supabase/server.ts` | Server-side client |
| `src/lib/supabase/client.ts` | Browser client |
| `src/lib/supabase/middleware.ts` | Session refresh |
| `src/app/auth/AuthForm.tsx` | Login / signup form |
| `src/app/auth/callback/route.ts` | OAuth callback |
| `src/app/auth/signout/route.ts` | Logout |
| `src/proxy.ts` | Route protection (calls `updateSession`) |

Packages: `@supabase/ssr`, `@supabase/supabase-js`.
Env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.

### Why this is smaller than it looks

**33 files** need to know who is signed in. None of them import Supabase — they
all call `getCurrentUser()` or `requireUser()` from `src/lib/auth.ts`. Replace
what is inside those two functions and the other 32 files do not change.

The contract a replacement must satisfy:

```ts
interface AppUser {
  id: string;          // MUST be stable — see the warning below
  orgId: string;
  email: string;
  displayName: string;
}

getCurrentUser(): Promise<AppUser | null>  // null when signed out
requireUser():    Promise<AppUser>         // throws "UNAUTHENTICATED"
```

It must also keep provisioning on first login: create the `User` row, attach it
to the default org (`00000000-0000-0000-0000-000000000001`), and be idempotent.

### ⚠ The part that bites: user identity

From `src/lib/auth.ts`:

```ts
id: string;  // our User.id (same as Supabase auth uid)
```

**`User.id` is the Supabase auth UID.** Meetings (`owner_user_id`) and minutes
(`assigned_to_user_id`) reference those UUIDs. Issue a new identity per user from
a different provider and every existing assignment points at a user that no
longer exists.

Do this instead: on first login with the new provider, **match on email** and
keep the existing `User.id`, rather than inserting a new row. `users.email` is
already unique, so it is a safe join key. `entraObjectId` exists on the model for
exactly this — store the new provider's subject there and leave `id` alone.

Verify after switching:

```sql
-- must return 0 rows
SELECT id FROM minutes WHERE assigned_to_user_id IS NOT NULL
  AND assigned_to_user_id NOT IN (SELECT id FROM users);
SELECT id FROM meetings WHERE owner_user_id IS NOT NULL
  AND owner_user_id NOT IN (SELECT id FROM users);
```

### Recommended replacement

**Microsoft Entra ID** (Auth.js / NextAuth with the Entra provider):

- Users are already on DECYP / TRACS / Entra — no new credentials to manage.
- Was already on the backlog as "Add Microsoft SSO (Entra) provider".
- Entra's `oid` claim is stable, so it maps cleanly onto `entraObjectId`.
- Removes the login-vs-roster confusion: `users.is_roster` distinguishes real
  team members from login accounts, and SSO makes that boundary meaningful.

---

## Status: auth has been replaced (this branch)

Supabase is gone from the codebase — `@supabase/ssr` and `@supabase/supabase-js`
are uninstalled and `src/lib/supabase/` is deleted. Login now runs on standard
OpenID Connect via `openid-client`, so the provider is configuration:

| File | Role |
|---|---|
| `src/lib/oidc.ts` | Discovers the provider from its issuer URL |
| `src/lib/session.ts` | Signed session cookie (JWT, 8 hours, httpOnly) |
| `src/lib/auth.ts` | Unchanged contract — `getCurrentUser()` / `requireUser()` |
| `src/app/api/auth/login` | Starts the flow (PKCE + state) |
| `src/app/api/auth/callback` | Exchanges the code, mints the session |
| `src/app/api/auth/signout` | Clears the session |
| `src/proxy.ts` | Verifies the cookie at the edge; no DB call |

**The 32 files that ask who is signed in did not change** — they still call
`getCurrentUser()` / `requireUser()`, which kept the same signature.

### Configure the provider

```
OIDC_ISSUER=https://login.microsoftonline.com/<tenant-id>/v2.0
OIDC_CLIENT_ID=<application id>
OIDC_CLIENT_SECRET=<client secret>
AUTH_SECRET=<random string, 32+ chars>
AUTH_URL=https://<this app's URL>        # optional
```

Register this redirect URI with the provider:

```
<AUTH_URL>/api/auth/callback
```

Until these are set, the sign-in page says so plainly rather than failing oddly.

### Existing users keep their ids

`getCurrentUser()` matches on **email** and reuses the `User.id` already in the
database; the OIDC subject is recorded in `entraObjectId`. So the Supabase-issued
ids that `meetings.owner_user_id` and `minutes.assigned_to_user_id` point at stay
valid. Run the two queries below after the first real sign-in to confirm.

### Remove afterwards

Once sign-in is verified, delete `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_ANON_KEY` from the environment — nothing reads them now.

---

## Order of work

1. ✅ Confirm the database is portable — `scripts/check-db.js` against the new server.
2. Move the data — `backup-sql.js`, restore, re-run `check-db.js`, compare counts.
3. Run the app against the new Postgres with Supabase auth still in place.
   *Proves the database half in isolation, with auth unchanged.*
4. Replace the internals of `auth.ts` with Entra; map users by email.
5. Delete `src/lib/supabase/`, the two packages, and the two `NEXT_PUBLIC_SUPABASE_*` vars.

Steps 1–3 are low risk and reversible. Step 4 is the one to schedule carefully:
a broken `getCurrentUser()` does not degrade gracefully — it locks everyone out.
Do it on a branch with a preview deployment, never straight onto `main`, which
deploys to production on every push.
