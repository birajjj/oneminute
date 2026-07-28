# OneMinute Cloud — AI editing guide

Read this file every time before editing this repo.

## Stack

- **Next.js 15** (App Router) + **React 19** + **TypeScript strict**
- **Tailwind CSS** for styling
- **Supabase Postgres** via **Prisma** for data
- **Supabase Auth** with **Microsoft Entra ID (Azure AD) SSO**
- **Gemini API** (`gemini-flash-latest`) for audio transcription + minute extraction
- **Vercel** for hosting
- **Vitest** unit tests, **Playwright** e2e tests

## Repo layout (memorize)

```
src/
  app/                     # Next.js routes. One folder = one page.
    (auth)/                # public routes
    (app)/                 # authenticated routes
    api/                   # server API routes
  components/
    ui/                    # primitive UI (button, input…)
    feature/               # business components (MeetingCard, MinuteEditor…)
  lib/
    db.ts                  # Prisma client singleton
    auth.ts                # requireAuth(), currentUser(), currentOrg()
    ai/                    # ALL Gemini calls live here
      transcribe.ts
      extract.ts
      auto-plan.ts
    policies/              # authorization rules (per feature)
  types/
    schemas.ts             # Zod schemas — every DTO
prisma/
  schema.prisma            # DB schema (source of truth)
  migrations/              # numbered SQL migrations, never edit past ones
tests/
  unit/                    # vitest
  e2e/                     # playwright
```

## Rules that MUST NOT be broken

1. **Every DB read/write goes through Prisma.** No raw SQL outside `prisma/migrations/`.
2. **Every table has `org_id`.** Every new table also gets a Row Level Security policy in a migration.
3. **Every API route calls `requireAuth()` first.** Public routes explicitly go under `src/app/(auth)/`.
4. **Every user-input string goes through Zod.** Parse at the API boundary, never trust `body: any`.
5. **`GEMINI_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are server-only.** Never import them into a Client Component.
6. **Every mutation writes to `audit_log`.** Use the `audited(...)` helper (in `src/lib/audit.ts` — build it if missing).
7. **Every `lib/` function needs a unit test.** Every user flow needs an e2e test.
8. **Never `any`.** Use `unknown` + Zod parse instead.
9. **Never delete a Prisma migration.** Add a new one.
10. **Never store PII in logs.** Log user IDs, never emails / names / meeting content.

## How to add a feature

1. Update `prisma/schema.prisma` if needed. Run `npm run db:migrate -- --name <verb>`.
2. Add or update Zod schemas in `src/types/schemas.ts`.
3. Write the business logic in `src/lib/<feature>/`. Add a unit test alongside.
4. Add the API route in `src/app/api/<verb-noun>/route.ts`. Call `requireAuth()` + Zod parse.
5. Add the UI in `src/app/(app)/<feature>/`. Prefer Server Components; use `"use client"` only when needed.
6. Write a Playwright e2e test in `tests/e2e/<feature>.spec.ts`.
7. Run `npm run typecheck && npm run lint && npm test` before opening a PR.

## Naming conventions

- Files: `kebab-case.ts`
- React components: `PascalCase.tsx`, one export default per file
- DB tables: `snake_case`, plural (`meetings`, not `meeting`)
- API routes: `/api/verb-noun` (`/api/create-meeting`, `/api/extract-minutes`)
- Prisma models: `PascalCase` singular
- Env vars: `SCREAMING_SNAKE_CASE`

## Semantic model (from on-prem OneMinute)

- **Project** — container of meetings.
- **Meeting** — belongs to a project. Has areas (tabs) and minutes (items).
- **Meeting.parentMeetingIdRaw:**
  - `null` → standalone meeting (auto-create `General` area only).
  - `"*ALL*"` → project-wide follow-up (copy all distinct areas from prior meetings of the project).
  - `<uuid>` → follow-up to that one meeting (copy areas from that meeting).
- **MeetingArea** — a tab within a meeting.
- **Minute** — an item under an area. `type` = Note | To-Do | Action | Devops.
- **Minute.parentMinuteId** — this minute is a follow-up update on that parent minute.
- **Minute.isPersistent** — when true (recommended for Action/To-Do/Devops), the minute stays "open" in future meetings until Completed. Replaces the on-prem `MinuteType='Standalone'` flag.
- **Meeting.completedParentMinuteIds** — list of parent minute IDs marked complete during this meeting (mirrors on-prem `MeetingMinuteID` CSV).

## Common pitfalls

- Prisma bigint values need `.toString()` before JSON serialisation.
- Server Components can't use `useState`. Move interactivity into a Client Component.
- Uploading files > 4MB via Server Actions needs `bodySizeLimit` in `next.config.js`.
- Gemini `responseSchema` doesn't accept `nullable: true` in the JS SDK — use enums or empty-string sentinel.
