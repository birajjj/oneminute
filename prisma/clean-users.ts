// One-off cleanup: mark the 7 roster members, then delete every other user row
// (old dev seed + login-derived duplicates). Owned meetings / assigned minutes
// are automatically set to null by the FK (onDelete: SetNull).
//
// Run: `npx tsx prisma/clean-users.ts`

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
  const rosterEmails = ROSTER.map(emailFor);

  // Ensure roster exists + flagged.
  for (const name of ROSTER) {
    const email = emailFor(name);
    await db.user.upsert({
      where: { email },
      update: { displayName: name, isRoster: true },
      create: { orgId: ORG_ID, email, displayName: name, isRoster: true }
    });
  }

  // Delete everything that isn't a roster member.
  const doomed = await db.user.findMany({
    where: { email: { notIn: rosterEmails } },
    select: { id: true, displayName: true, email: true }
  });

  for (const u of doomed) {
    await db.user.delete({ where: { id: u.id } });
    console.log("🗑  deleted:", u.displayName, `(${u.email})`);
  }

  const remaining = await db.user.findMany({
    orderBy: { displayName: "asc" },
    select: { displayName: true, isRoster: true }
  });
  console.log("\nRemaining users:");
  remaining.forEach((u) => console.log(`  ${u.isRoster ? "✔" : " "} ${u.displayName}`));
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => db.$disconnect());
