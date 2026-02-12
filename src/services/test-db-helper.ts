import { PrismaClient } from "@prisma/client";

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  "postgresql://dictator@localhost:5432/billing_test";

let client: PrismaClient | undefined;

export function getTestPrisma(): PrismaClient {
  if (!client) {
    client = new PrismaClient({
      datasources: { db: { url: TEST_DATABASE_URL } },
    });
  }
  return client;
}

export async function disconnectTestPrisma(): Promise<void> {
  if (client) {
    await client.$disconnect();
    client = undefined;
  }
}

/**
 * Creates an App record to serve as FK target for Plans/Addons.
 * Uses random IDs to avoid conflicts across parallel test files.
 */
export async function createTestApp(
  prisma: PrismaClient,
  overrides: { id?: string; name?: string } = {},
): Promise<{ id: string; name: string }> {
  return prisma.app.create({
    data: {
      id: overrides.id ?? `app-${randomSuffix()}`,
      name: overrides.name ?? "Test App",
    },
  });
}

/**
 * Creates a Team record to serve as FK target for TeamSubscription/TeamAddon.
 */
export async function createTestTeam(
  prisma: PrismaClient,
  overrides: {
    id?: string;
    name?: string;
    kind?: "PERSONAL" | "STANDARD" | "ENTERPRISE";
  } = {},
): Promise<{ id: string; name: string }> {
  return prisma.team.create({
    data: {
      id: overrides.id ?? `team-${randomSuffix()}`,
      name: overrides.name ?? "Test Team",
      kind: overrides.kind ?? "STANDARD",
    },
  });
}

/**
 * Creates a BillingEntity record to serve as FK target for Contract.
 * Optionally links to a Team.
 */
export async function createTestBillingEntity(
  prisma: PrismaClient,
  overrides: { id?: string; teamId?: string } = {},
): Promise<{ id: string }> {
  return prisma.billingEntity.create({
    data: {
      id: overrides.id ?? `be-${randomSuffix()}`,
      type: "TEAM",
      teamId: overrides.teamId ?? undefined,
    },
  });
}

/**
 * Creates a Bundle record to serve as FK target for Contract/BundleApp/BundleMeterPolicy.
 */
export async function createTestBundle(
  prisma: PrismaClient,
  overrides: { id?: string; code?: string; name?: string } = {},
): Promise<{ id: string; code: string; name: string }> {
  return prisma.bundle.create({
    data: {
      id: overrides.id ?? `bundle-${randomSuffix()}`,
      code: overrides.code ?? `bundle-code-${randomSuffix()}`,
      name: overrides.name ?? "Test Bundle",
    },
  });
}

export function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 10);
}
