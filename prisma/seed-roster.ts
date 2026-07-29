// Seeds the team roster (reference data for "Assigned To").
// Mirrors the on-prem OneMinute dbo.User table.
// Run: `npx tsx prisma/seed-roster.ts`

import { PrismaClient } from "@prisma/client";

const ORG_ID = "00000000-0000-0000-0000-000000000001";

const ROSTER = [
  "Rob Stoneman",
  "Biraj Joshi",
  "Kaili Cen",
  "Rifat Fajrianto",
  "Warrick Goddard",
  "Matthew McDermott",
  "Vanessa Regan"
];

function emailFor(name: string): string {
  return name.toLowerCase().replace(/[^a-z]+/g, ".") + "@3tt.roster.local";
}

const db = new PrismaClient();

async function main() {
  await db.org.upsert({
    where: { id: ORG_ID },
    update: {},
    create: { id: ORG_ID, name: "3TT" }
  });

  for (const name of ROSTER) {
    const email = emailFor(name);
    await db.user.upsert({
      where: { email },
      update: { displayName: name },
      create: { orgId: ORG_ID, email, displayName: name }
    });
    console.log("✔ roster:", name);
  }

  console.log("\nRoster seed complete.");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => db.$disconnect());
