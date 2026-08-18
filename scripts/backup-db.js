// Full data backup of the Supabase database, using the Prisma client that is
// already installed — no Docker, no local Postgres tools.
//
//   node --env-file=.env scripts/backup-db.js
//
// Writes backups/backup-<timestamp>.json containing every row of every table.
// Attachment file bytes are base64-encoded so they survive the round trip.
//
// The SCHEMA is not dumped here — it lives in prisma/schema.prisma, which is in
// git and is the source of truth. To rebuild an empty database from it:
//   npx prisma db push
// Then restore the data with scripts/restore-db.js.
//
// Reads DATABASE_URL from the environment; the value is never printed.

const fs = require("fs");
const path = require("path");
const { PrismaClient } = require("@prisma/client");

// Order matters for restore: parents before the rows that reference them.
const MODELS = [
  "org",
  "user",
  "project",
  "meeting",
  "meetingArea",
  "minute",
  "attachment",
  "stakeholder",
  "auditLog",
  "analysisJob"
];

(async () => {
  const db = new PrismaClient();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const dir = path.join(process.cwd(), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `backup-${stamp}.json`);

  const out = { takenAt: new Date().toISOString(), tables: {} };
  let total = 0;

  for (const model of MODELS) {
    if (!db[model]) {
      console.log(`  skip ${model} (not in this client)`);
      continue;
    }
    const rows = await db[model].findMany();
    // Buffers (Attachment.data) -> base64 so JSON stays valid and compact.
    const clean = rows.map((r) => {
      const o = {};
      for (const [k, v] of Object.entries(r)) {
        if (Buffer.isBuffer(v)) o[k] = { __buffer: v.toString("base64") };
        // BigInt has no JSON representation — tag it so restore can rebuild it.
        else if (typeof v === "bigint") o[k] = { __bigint: v.toString() };
        else o[k] = v;
      }
      return o;
    });
    out.tables[model] = clean;
    total += clean.length;
    console.log(`  ${model.padEnd(14)} ${clean.length} rows`);
  }

  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  const mb = (fs.statSync(file).size / 1024 / 1024).toFixed(2);
  console.log(`\nWrote ${file}`);
  console.log(`${total} rows, ${mb} MB`);
  await db.$disconnect();
})().catch((e) => {
  console.error("Backup failed:", e.message);
  process.exit(1);
});
