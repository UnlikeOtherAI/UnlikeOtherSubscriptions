import { createHmac, randomUUID } from "node:crypto";
import type { JwtClaims } from "./types.js";

function base64UrlEncode(data: string | Buffer): string {
  const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface SignJwtOptions {
  appId: string;
  secret: string;
  kid: string;
  ttlSeconds: number;
  teamId?: string;
  userId?: string;
  scopes?: string[];
}

/**
 * Signs a JWT with HMAC-SHA256 for authenticating with the billing service.
 * Returns the signed JWT string.
 */
export function signJwt(options: SignJwtOptions): string {
  const { appId, secret, kid, ttlSeconds, teamId, userId, scopes } = options;
  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: "HS256",
    typ: "JWT",
    kid,
  };

  const sub = teamId ? `team:${teamId}` : userId ? `user:${userId}` : `app:${appId}`;

  const payload: JwtClaims = {
    iss: `app:${appId}`,
    aud: "billing-service",
    sub,
    appId,
    teamId,
    userId,
    scopes: scopes ?? ["usage:write", "billing:read", "entitlements:read"],
    iat: now,
    exp: now + ttlSeconds,
    jti: randomUUID(),
    kid,
  };

  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const data = `${headerB64}.${payloadB64}`;
  const signature = createHmac("sha256", secret).update(data).digest();
  const signatureB64 = base64UrlEncode(signature);

  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

/**
 * Decodes a JWT without verifying the signature.
 * Used for inspecting tokens in tests.
 */
export function decodeJwt(token: string): { header: Record<string, unknown>; payload: JwtClaims } {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw new Error("Invalid JWT format");
  }
  const header = JSON.parse(Buffer.from(parts[0], "base64").toString("utf-8")) as Record<string, unknown>;
  const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf-8")) as JwtClaims;
  return { header, payload };
}
