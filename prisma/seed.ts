// Seeds the DB with a single dev org + user so we can build features
// before wiring up real auth. Run: `npx tsx prisma/seed.ts`
//
// IDs are FIXED (hard-coded) so src/lib/dev-context.ts can point at them
// without needing to query on every request.

import { PrismaClient } from "@prisma/client";

const DEV_ORG_ID  = "00000000-0000-0000-0000-000000000001";
const DEV_USER_ID = "00000000-0000-0000-0000-000000000002";

const db = new PrismaClient();

async function main() {
  const org = await db.org.upsert({
    where: { id: DEV_ORG_ID },
    update: { name: "3TT (dev)" },
    create: { id: DEV_ORG_ID, name: "3TT (dev)" }
  });
  console.log("✔ org:", org.name);

  const user = await db.user.upsert({
    where: { id: DEV_USER_ID },
    update: {},
    create: {
      id: DEV_USER_ID,
      orgId: DEV_ORG_ID,
      email: "biraj@3tt.com.au",
      displayName: "Biraj"
    }
  });
  console.log("✔ user:", user.email);

  const project = await db.project.upsert({
    where: { orgId_name: { orgId: DEV_ORG_ID, name: "Complaints Management" } },
    update: {},
    create: { orgId: DEV_ORG_ID, name: "Complaints Management" }
  });
  console.log("✔ sample project:", project.name);

  console.log("\nSeed complete.");
  console.log("  DEV_ORG_ID  =", DEV_ORG_ID);
  console.log("  DEV_USER_ID =", DEV_USER_ID);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
