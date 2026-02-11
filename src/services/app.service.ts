import { randomBytes } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { getPrismaClient } from "../lib/prisma.js";
import { encryptSecret } from "../lib/crypto.js";

export interface CreateAppResult {
  id: string;
  name: string;
  status: string;
}

export interface GenerateSecretResult {
  kid: string;
  secret: string;
}

export class AppService {
  async createApp(name: string): Promise<CreateAppResult> {
    const prisma = getPrismaClient();
    const app = await prisma.app.create({
      data: { name },
    });
    return { id: app.id, name: app.name, status: app.status };
  }

  async getApp(appId: string): Promise<CreateAppResult | null> {
    const prisma = getPrismaClient();
    const app = await prisma.app.findUnique({
      where: { id: appId },
    });
    if (!app) return null;
    return { id: app.id, name: app.name, status: app.status };
  }

  async generateSecret(appId: string): Promise<GenerateSecretResult | null> {
    const prisma = getPrismaClient();

    const app = await prisma.app.findUnique({ where: { id: appId } });
    if (!app) return null;

    const kid = `kid_${uuidv4().replace(/-/g, "")}`;
    const secret = randomBytes(32).toString("hex");

    // Encrypt the secret before storing — the JWT auth middleware decrypts it
    // at verification time to use as the HMAC signing key.
    const encrypted = encryptSecret(secret);

    await prisma.appSecret.create({
      data: {
        appId,
        kid,
        secretHash: encrypted,
      },
    });

    return { kid, secret };
  }

  async revokeSecret(appId: string, kid: string): Promise<boolean> {
    const prisma = getPrismaClient();

    const appSecret = await prisma.appSecret.findUnique({
      where: { kid },
    });

    if (!appSecret || appSecret.appId !== appId) {
      return false;
    }

    if (appSecret.status === "REVOKED") {
      return true;
    }

    await prisma.appSecret.update({
      where: { kid },
      data: {
        status: "REVOKED",
        revokedAt: new Date(),
      },
    });

    return true;
  }
}
