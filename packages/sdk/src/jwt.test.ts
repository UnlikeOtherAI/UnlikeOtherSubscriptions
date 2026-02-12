import { describe, it, expect } from "vitest";
import { createHmac } from "node:crypto";
import { signJwt, decodeJwt } from "./jwt.js";

const TEST_SECRET = "test-secret-key-for-hmac-signing";
const TEST_KID = "kid_test123";
const TEST_APP_ID = "app_test";

describe("signJwt", () => {
  it("produces a valid three-part JWT", () => {
    const token = signJwt({
      appId: TEST_APP_ID,
      secret: TEST_SECRET,
      kid: TEST_KID,
      ttlSeconds: 60,
    });

    const parts = token.split(".");
    expect(parts).toHaveLength(3);
  });

  it("includes correct header with alg=HS256 and kid", () => {
    const token = signJwt({
      appId: TEST_APP_ID,
      secret: TEST_SECRET,
      kid: TEST_KID,
      ttlSeconds: 60,
    });

    const { header } = decodeJwt(token);
    expect(header.alg).toBe("HS256");
    expect(header.typ).toBe("JWT");
    expect(header.kid).toBe(TEST_KID);
  });

  it("includes all required claims", () => {
    const token = signJwt({
      appId: TEST_APP_ID,
      secret: TEST_SECRET,
      kid: TEST_KID,
      ttlSeconds: 120,
      teamId: "team_xyz",
      userId: "user_abc",
      scopes: ["usage:write", "billing:read"],
    });

    const { payload } = decodeJwt(token);
    expect(payload.iss).toBe("app:app_test");
    expect(payload.aud).toBe("billing-service");
    expect(payload.sub).toBe("team:team_xyz");
    expect(payload.appId).toBe(TEST_APP_ID);
    expect(payload.teamId).toBe("team_xyz");
    expect(payload.userId).toBe("user_abc");
    expect(payload.scopes).toEqual(["usage:write", "billing:read"]);
    expect(payload.kid).toBe(TEST_KID);
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    expect(payload.exp - payload.iat).toBe(120);
    expect(typeof payload.jti).toBe("string");
    expect(payload.jti.length).toBeGreaterThan(0);
  });

  it("uses default scopes when none provided", () => {
    const token = signJwt({
      appId: TEST_APP_ID,
      secret: TEST_SECRET,
      kid: TEST_KID,
      ttlSeconds: 60,
    });

    const { payload } = decodeJwt(token);
    expect(payload.scopes).toEqual(["usage:write", "billing:read", "entitlements:read"]);
  });

  it("sets sub to user:{userId} when teamId not provided", () => {
    const token = signJwt({
      appId: TEST_APP_ID,
      secret: TEST_SECRET,
      kid: TEST_KID,
      ttlSeconds: 60,
      userId: "user_abc",
    });

    const { payload } = decodeJwt(token);
    expect(payload.sub).toBe("user:user_abc");
  });

  it("sets sub to app:{appId} when neither teamId nor userId provided", () => {
    const token = signJwt({
      appId: TEST_APP_ID,
      secret: TEST_SECRET,
      kid: TEST_KID,
      ttlSeconds: 60,
    });

    const { payload } = decodeJwt(token);
    expect(payload.sub).toBe("app:app_test");
  });

  it("generates unique jti for each call", () => {
    const token1 = signJwt({ appId: TEST_APP_ID, secret: TEST_SECRET, kid: TEST_KID, ttlSeconds: 60 });
    const token2 = signJwt({ appId: TEST_APP_ID, secret: TEST_SECRET, kid: TEST_KID, ttlSeconds: 60 });

    const { payload: p1 } = decodeJwt(token1);
    const { payload: p2 } = decodeJwt(token2);
    expect(p1.jti).not.toBe(p2.jti);
  });

  it("produces a verifiable HMAC-SHA256 signature", () => {
    const token = signJwt({
      appId: TEST_APP_ID,
      secret: TEST_SECRET,
      kid: TEST_KID,
      ttlSeconds: 60,
    });

    const parts = token.split(".");
    const data = `${parts[0]}.${parts[1]}`;
    const expectedSig = createHmac("sha256", TEST_SECRET).update(data).digest();
    const expectedSigB64 = expectedSig
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    expect(parts[2]).toBe(expectedSigB64);
  });
});

describe("decodeJwt", () => {
  it("throws on invalid JWT format", () => {
    expect(() => decodeJwt("not-a-jwt")).toThrow("Invalid JWT format");
    expect(() => decodeJwt("a.b")).toThrow("Invalid JWT format");
  });

  it("decodes a valid JWT", () => {
    const token = signJwt({
      appId: TEST_APP_ID,
      secret: TEST_SECRET,
      kid: TEST_KID,
      ttlSeconds: 60,
      teamId: "team_1",
    });

    const { header, payload } = decodeJwt(token);
    expect(header.alg).toBe("HS256");
    expect(payload.appId).toBe(TEST_APP_ID);
    expect(payload.teamId).toBe("team_1");
  });
});
