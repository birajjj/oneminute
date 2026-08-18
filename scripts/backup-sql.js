// Produces a runnable PostgreSQL .sql file: schema (DDL) + data (INSERTs).
//
//   node --env-file=.env scripts/backup-sql.js
//
// Unlike the JSON backup, the output can be executed directly against an empty
// Postgres database (psql, pgAdmin, or the Supabase SQL editor) and will
// recreate the tables and every row.
//
// POSTGRES ONLY. The schema uses Postgres features with no MySQL equivalent —
// text[] arrays, enum types, uuid and bytea columns — so this will not run on
// MySQL or SQL Server without a rewrite.
//
// The DDL comes from prisma/schema.prisma via `prisma migrate diff`, so it is
// always in step with the schema in git.

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { PrismaClient } = require("@prisma/client");

// Prisma model -> real table name, in insert order (parents before children).
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

// camelCase field -> snake_case column, matching the @map()s in the schema.
function col(field) {
  return field.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
}

const BACKSLASH = String.fromCharCode(92);

function quote(s) {
  // Postgres escapes a single quote by doubling it.
  return "'" + String(s).split("'").join("''") + "'";
}

function literal(v) {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return String(v);
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return quote(v.toISOString());
  // bytea hex format: '\xDEADBEEF'
  if (Buffer.isBuffer(v)) return "'" + BACKSLASH + "x" + v.toString("hex") + "'";
  if (Array.isArray(v)) {
    // text[] literal: '{"a","b"}' — backslashes and quotes doubled/escaped.
    const inner = v
      .map((x) => {
        const esc = String(x)
          .split(BACKSLASH)
          .join(BACKSLASH + BACKSLASH)
          .split('"')
          .join(BACKSLASH + '"');
        return '"' + esc + '"';
      })
      .join(",");
    return quote("{" + inner + "}");
  }
  if (typeof v === "object") return quote(JSON.stringify(v)) + "::jsonb";
  return quote(v);
}

// Orders self-referencing rows so every row comes after the rows it points at.
// A reference to an id that isn't in the set (already deleted) is ignored — the
// column is nullable and the FK is ON DELETE SET NULL.
function topoSort(rows) {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = [];
  const placed = new Set();
  const visiting = new Set();

  const visit = (row) => {
    if (placed.has(row.id) || visiting.has(row.id)) return;
    visiting.add(row.id);
    for (const dep of [row.parentMinuteId, row.raisedFromRootId]) {
      if (dep && dep !== row.id && byId.has(dep)) visit(byId.get(dep));
    }
    visiting.delete(row.id);
    placed.add(row.id);
    out.push(row);
  };

  for (const r of rows) visit(r);
  return out;
}

(async () => {
  const db = new PrismaClient();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 16);
  const dir = path.join(process.cwd(), "backups");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `dump-${stamp}.sql`);

  const parts = [];
  parts.push(`-- OneMinute database dump — ${new Date().toISOString()}`);
  parts.push("-- PostgreSQL. Run against an EMPTY database:");
  parts.push(`--   psql "<connection-string>" -f ${path.basename(file)}`);
  parts.push("");

  // ---- Schema ----
  parts.push("-- ============ SCHEMA ============");
  const ddl = execSync(
    "npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script",
    { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 }
  );
  parts.push(ddl.trim());
  parts.push("");

  // ---- Data ----
  parts.push("-- ============ DATA ============");
  let total = 0;
  for (const [model, table] of TABLES) {
    if (!db[model]) continue;
    const rows = await db[model].findMany();
    if (rows.length === 0) {
      parts.push(`-- ${table}: no rows`);
      continue;
    }
    // `minutes` references itself twice (parent_minute_id, raised_from_root_id),
    // so a row must not be inserted before the row it points at. Emit in
    // dependency order rather than whatever order the query returned.
    const ordered = model === "minute" ? topoSort(rows) : rows;

    const fields = Object.keys(rows[0]);
    const cols = fields.map((f) => '"' + col(f) + '"').join(", ");
    parts.push(`-- ${table}: ${rows.length} rows`);
    for (const r of ordered) {
      const vals = fields.map((f) => literal(r[f])).join(", ");
      parts.push(`INSERT INTO "${table}" (${cols}) VALUES (${vals});`);
    }
    parts.push("");
    total += rows.length;
    console.log(`  ${table.padEnd(16)} ${rows.length} rows`);
  }

  fs.writeFileSync(file, parts.join("\n"));
  const mb = (fs.statSync(file).size / 1024 / 1024).toFixed(2);
  console.log(`\nWrote ${file}`);
  console.log(`${total} rows, ${mb} MB`);
  await db.$disconnect();
})().catch((e) => {
  console.error("SQL dump failed:", e.message);
  process.exit(1);
});
