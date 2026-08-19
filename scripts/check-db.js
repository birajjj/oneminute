// Verifies that whatever DATABASE_URL points at is a usable Postgres for this
// app — used when moving off Supabase to confirm the new server is ready before
// switching anything over.
//
//   node --env-file=.env.newdb scripts/check-db.js
//
// Checks, in order:
//   1. it connects at all
//   2. it is PostgreSQL (and which version)
//   3. every table this app needs exists
//   4. row counts, so you can compare against the old database
//
// Read-only — it never writes. The connection string is never printed.

const { PrismaClient } = require("@prisma/client");

// Prisma model -> table name, matching the @map()s in schema.prisma.
const TABLES = [
  ["org", "orgs"],
  ["user", "users"],
  ["project", "projects"],
  ["meeting", "meetings"],
  ["meetingArea", "meeting_areas"],
  ["minute", "minutes"],
  ["attachment", "attachments"],
  ["stakeholder", "stakeholders"],
  ["auditLog", "audit_logs"],
  ["analysisJob", "analysis_jobs"]
];

(async () => {
  const db = new PrismaClient();

  // 1 + 2: connectivity and flavour.
  let version;
  try {
    const rows = await db.$queryRawUnsafe("SELECT version()");
    version = rows[0].version;
  } catch (e) {
    console.error("Could not connect:", e.message);
    console.error("\nCheck DATABASE_URL — host, port, database, user, and that");
    console.error("this machine is allowed through the server's firewall.");
    process.exit(1);
  }

  if (!/PostgreSQL/i.test(version)) {
    console.error("Connected, but this is not PostgreSQL:\n  " + version);
    console.error("\nThis app requires Postgres — the schema uses text[] arrays,");
    console.error("enum types, uuid and bytea, none of which MySQL supports as-is.");
    process.exit(1);
  }
  console.log("Connected");
  console.log("  " + version.split(",")[0]);

  // Where we are connected, without exposing credentials.
  try {
    const who = await db.$queryRawUnsafe(
      "SELECT current_database() AS db, current_user AS usr, inet_server_addr()::text AS host"
    );
    console.log(`  database=${who[0].db} user=${who[0].usr} host=${who[0].host ?? "local"}`);
  } catch {
    /* inet_server_addr is null on some managed hosts — not important */
  }

  // 3 + 4: schema present, and how much is in it.
  console.log("\nTables:");
  let missing = 0;
  let total = 0;
  for (const [model, table] of TABLES) {
    try {
      const n = await db[model].count();
      total += n;
      console.log(`  ${table.padEnd(16)} ${String(n).padStart(6)} rows`);
    } catch (e) {
      missing++;
      const why = /does not exist/i.test(e.message) ? "MISSING" : e.message.split("\n")[0];
      console.log(`  ${table.padEnd(16)} ${why}`);
    }
  }

  if (missing > 0) {
    console.log(`\n${missing} table(s) missing — create the schema first:`);
    console.log("  npx prisma db push          (build it from prisma/schema.prisma)");
    console.log("  psql <conn> -f backups/dump-*.sql   (schema + data from a dump)");
    process.exit(1);
  }

  console.log(`\nAll ${TABLES.length} tables present, ${total} rows total.`);
  console.log("This database is ready for the app.");
  await db.$disconnect();
})().catch((e) => {
  console.error("Check failed:", e.message);
  process.exit(1);
});
