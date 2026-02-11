import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getPrismaClient } from "../lib/prisma.js";
import { decryptSecret } from "../lib/crypto.js";
import type { JwtClaims } from "../types/fastify.js";

const EXPECTED_AUDIENCE = "billing-service";

const SKIP_AUTH_ROUTES = new Set(["/healthz", "/v1/stripe/webhook"]);

function base64UrlDecode(str: string): Buffer {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

function base64UrlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sendUnauthorized(reply: FastifyReply, message: string, requestId: string): void {
  void reply.status(401).send({
    error: "Unauthorized",
    message,
    statusCode: 401,
    requestId,
  });
}

function parseJwtParts(token: string): { headerB64: string; payloadB64: string; signatureB64: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  return {
    headerB64: parts[0],
    payloadB64: parts[1],
    signatureB64: parts[2],
  };
}

function decodeJsonPart(b64: string): Record<string, unknown> | null {
  try {
    const json = base64UrlDecode(b64).toString("utf-8");
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function verifyHmacSignature(headerB64: string, payloadB64: string, signatureB64: string, secret: string): boolean {
  const data = `${headerB64}.${payloadB64}`;
  const expectedSig = createHmac("sha256", secret).update(data).digest();
  const actualSig = base64UrlDecode(signatureB64);

  if (expectedSig.length !== actualSig.length) return false;
  return timingSafeEqual(expectedSig, actualSig);
}

function validateClaims(payload: Record<string, unknown>): { claims: JwtClaims; error?: string } | { claims?: undefined; error: string } {
  const now = Math.floor(Date.now() / 1000);

  const iss = payload.iss;
  const aud = payload.aud;
  const exp = payload.exp;
  const iat = payload.iat;
  const jti = payload.jti;
  const kid = payload.kid;
  const appId = payload.appId;
  const scopes = payload.scopes;
  const sub = payload.sub;

  if (typeof iss !== "string" || !iss.startsWith("app:")) {
    return { error: "Invalid issuer" };
  }

  if (aud !== EXPECTED_AUDIENCE) {
    return { error: "Invalid audience" };
  }

  if (typeof exp !== "number" || exp <= now) {
    return { error: "Token expired" };
  }

  if (typeof iat !== "number" || iat > now) {
    return { error: "Token issued in the future" };
  }

  if (typeof jti !== "string" || jti.length === 0) {
    return { error: "Missing jti claim" };
  }

  if (typeof kid !== "string" || kid.length === 0) {
    return { error: "Missing kid claim" };
  }

  if (typeof appId !== "string" || appId.length === 0) {
    return { error: "Missing appId claim" };
  }

  // Verify iss matches appId
  if (iss !== `app:${appId}`) {
    return { error: "Issuer does not match appId" };
  }

  if (!Array.isArray(scopes)) {
    return { error: "Missing or invalid scopes" };
  }

  if (typeof sub !== "string" || sub.length === 0) {
    return { error: "Missing sub claim" };
  }

  return {
    claims: {
      iss: iss as string,
      aud: aud as string,
      sub: sub as string,
      appId: appId as string,
      teamId: typeof payload.teamId === "string" ? payload.teamId : undefined,
      userId: typeof payload.userId === "string" ? payload.userId : undefined,
      scopes: scopes as string[],
      iat: iat as number,
      exp: exp as number,
      jti: jti as string,
      kid: kid as string,
      reqHash: typeof payload.reqHash === "string" ? payload.reqHash : undefined,
    },
  };
}

export function registerJwtAuth(app: FastifyInstance): void {
  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.requestId ?? "unknown";

    if (SKIP_AUTH_ROUTES.has(request.url)) {
      return;
    }

    // Also skip by routeOptions path pattern for parameterized routes
    const routePath = request.routeOptions?.url;
    if (routePath && SKIP_AUTH_ROUTES.has(routePath)) {
      return;
    }

    // Skip JWT auth for admin routes — they are secured by the admin API key middleware
    if (request.url.startsWith("/v1/admin/") || (routePath && routePath.startsWith("/v1/admin/"))) {
      return;
    }

    const authHeader = request.headers.authorization;
    if (!authHeader || typeof authHeader !== "string") {
      return sendUnauthorized(reply, "Missing Authorization header", requestId);
    }

    if (!authHeader.startsWith("Bearer ")) {
      return sendUnauthorized(reply, "Malformed Authorization header", requestId);
    }

    const token = authHeader.slice(7);
    if (token.length === 0) {
      return sendUnauthorized(reply, "Empty bearer token", requestId);
    }

    // Parse JWT parts
    const parts = parseJwtParts(token);
    if (!parts) {
      return sendUnauthorized(reply, "Malformed JWT", requestId);
    }

    // Decode header to get kid
    const header = decodeJsonPart(parts.headerB64);
    if (!header) {
      return sendUnauthorized(reply, "Malformed JWT header", requestId);
    }

    if (header.alg !== "HS256") {
      return sendUnauthorized(reply, "Unsupported algorithm", requestId);
    }

    const kid = header.kid;
    if (typeof kid !== "string" || kid.length === 0) {
      return sendUnauthorized(reply, "Missing kid in JWT header", requestId);
    }

    // Look up AppSecret by kid
    const prisma = getPrismaClient();
    const appSecret = await prisma.appSecret.findUnique({
      where: { kid },
    });

    if (!appSecret) {
      return sendUnauthorized(reply, "Unknown key ID", requestId);
    }

    if (appSecret.status !== "ACTIVE") {
      return sendUnauthorized(reply, "Key has been revoked", requestId);
    }

    // Decrypt the stored secret to use for HMAC verification
    let signingKey: string;
    try {
      signingKey = decryptSecret(appSecret.secretHash);
    } catch {
      return sendUnauthorized(reply, "Failed to verify key", requestId);
    }

    // Verify HMAC signature using the decrypted secret
    if (!verifyHmacSignature(parts.headerB64, parts.payloadB64, parts.signatureB64, signingKey)) {
      return sendUnauthorized(reply, "Invalid signature", requestId);
    }

    // Decode and validate payload
    const payload = decodeJsonPart(parts.payloadB64);
    if (!payload) {
      return sendUnauthorized(reply, "Malformed JWT payload", requestId);
    }

    const validation = validateClaims(payload);
    if (validation.error) {
      return sendUnauthorized(reply, validation.error, requestId);
    }

    const claims = validation.claims!;

    // Verify kid in payload matches header kid
    if (claims.kid !== kid) {
      return sendUnauthorized(reply, "kid mismatch between header and payload", requestId);
    }

    // Verify appId matches the AppSecret's appId
    if (claims.appId !== appSecret.appId) {
      return sendUnauthorized(reply, "appId does not match key", requestId);
    }

    // Replay protection: check and store jti
    try {
      await prisma.jtiUsage.create({
        data: {
          jti: claims.jti,
          expiresAt: new Date(claims.exp * 1000),
        },
      });
    } catch (err: unknown) {
      // Unique constraint violation means jti was already used
      if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "P2002") {
        return sendUnauthorized(reply, "Token has already been used", requestId);
      }
      throw err;
    }

    // Attach claims to request
    request.jwtClaims = claims;
  });
}
