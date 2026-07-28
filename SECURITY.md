# Security review checklist

Every PR (especially AI-generated) must pass this checklist before merge.
The reviewer (you) signs off in the PR description.

## Auth & authorization

- [ ] Every new API route calls `requireAuth()` as the first line
- [ ] Any route that mutates data checks that the target row's `org_id` matches the caller's org
- [ ] No route accepts `orgId` from the request body — it always comes from the session
- [ ] Public routes are explicitly under `src/app/(auth)/` and named clearly

## Data isolation

- [ ] Every new table has `org_id NOT NULL`
- [ ] Every new table has an RLS policy in a migration under `prisma/migrations/`
- [ ] No raw SQL bypasses Prisma (grep for `db.$queryRaw` — should be zero uses outside migrations)

## Input validation

- [ ] Every API route parses the body with a Zod schema before touching the DB
- [ ] No `as any` casts on request input
- [ ] File uploads have size + MIME type limits enforced server-side

## Secrets

- [ ] No secrets in the diff (checked by GitGuardian / TruffleHog CI job)
- [ ] `GEMINI_API_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL` only referenced in `src/lib/` and `prisma/`
- [ ] No `process.env.NEXT_PUBLIC_*` used for anything sensitive

## Audit + observability

- [ ] Every mutation writes to `audit_log`
- [ ] Errors are logged with user_id + org_id, never with email or content
- [ ] No `console.log` of user content in production code

## AI-specific

- [ ] AI-generated content is treated as untrusted (parsed with Zod, never `eval`, never rendered as HTML)
- [ ] The system prompt does not leak DB schema secrets
- [ ] Rate limits enforced on `/api/analyze` and `/api/transcribe`

## After merge

- [ ] Verify preview URL matches expectation
- [ ] Watch first 10 minutes of Vercel logs for errors
- [ ] Have a revert plan ready (one-click revert in GitHub)
