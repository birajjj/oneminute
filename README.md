# OneMinute Cloud

Cloud-native rebuild of OneMinute with AI-driven meeting capture.

Read [CLAUDE.md](./CLAUDE.md) before making any changes (human or AI).

## Quick start

```bash
npm install
cp .env.example .env.local          # fill in Supabase + Gemini values
npx prisma generate
npm run dev                          # http://localhost:3000
```

## Deploy

Push to `main` → Vercel auto-deploys.
Pull requests get their own preview URLs.

## Stack

- Next.js 15 + TypeScript
- Supabase Postgres (via Prisma) + Supabase Auth (Microsoft SSO)
- Gemini API (`gemini-flash-latest`) for audio + minute extraction
- Vercel hosting
- Vitest + Playwright tests
