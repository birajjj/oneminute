// Restores a backup produced by scripts/backup-db.js.
//
//   node --env-file=.env scripts/restore-db.js backups/backup-<stamp>.json
//
// Inserts rows in dependency order and SKIPS any row whose id already exists,
// so running it against a populated database will not overwrite or delete
// anything. To restore into a clean database, run `npx prisma db push` against
// an empty one first.
//
// Refuses to run without --yes, since it writes to whatever DATABASE_URL points
// at — make sure that is the database you intend.

const fs = require("fs");
const { PrismaClient } = require("@prisma/client");

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
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: node --env-file=.env scripts/restore-db.js <backup.json> --yes");
    process.exit(1);
  }
  if (!process.argv.includes("--yes")) {
    console.error(
      "This writes to the database in DATABASE_URL. Re-run with --yes once you have checked it is the right one."
    );
    process.exit(1);
  }

  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const db = new PrismaClient();
  let inserted = 0;
  let skipped = 0;

  for (const model of MODELS) {
    const rows = data.tables[model] || [];
    for (const row of rows) {
      const r = {};
      for (const [k, v] of Object.entries(row)) {
        if (v && typeof v === "object" && v.__buffer) r[k] = Buffer.from(v.__buffer, "base64");
        else if (v && typeof v === "object" && v.__bigint) r[k] = BigInt(v.__bigint);
        else r[k] = v;
      }
      try {
        await db[model].create({ data: r });
        inserted++;
      } catch (e) {
        // Unique violation = the row is already there; anything else is real.
        if (e.code === "P2002") skipped++;
        else throw e;
      }
    }
    if (rows.length) console.log(`  ${model.padEnd(14)} ${rows.length} rows processed`);
  }

  console.log(`\nInserted ${inserted}, skipped ${skipped} already present.`);
  await db.$disconnect();
})().catch((e) => {
  console.error("Restore failed:", e.message);
  process.exit(1);
});
