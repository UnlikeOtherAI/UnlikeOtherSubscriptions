import { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { createBillingClient, BillingClient } from "../client.js";

export const TEST_ENCRYPTION_KEY = randomBytes(32).toString("hex");
export const TEST_SECRET = randomBytes(32).toString("hex");
export const TEST_KID = `kid_${uuidv4().replace(/-/g, "")}`;
export const TEST_APP_ID = uuidv4();
export const TEST_TEAM_ID = uuidv4();

/**
 * Starts a Fastify app on an ephemeral port and returns
 * the base URL and a teardown function.
 */
export async function startApp(
  app: FastifyInstance,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  return {
    baseUrl: address,
    close: () => app.close(),
  };
}

/**
 * Creates an SDK BillingClient pointed at the given baseUrl.
 */
export function makeSdkClient(baseUrl: string): BillingClient {
  return createBillingClient({
    appId: TEST_APP_ID,
    secret: TEST_SECRET,
    kid: TEST_KID,
    baseUrl,
    maxRetries: 0,
    timeout: 5000,
  });
}
