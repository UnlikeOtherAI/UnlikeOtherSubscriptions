import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { encryptSecret, decryptSecret } from "./crypto.js";

const TEST_ENCRYPTION_KEY = randomBytes(32).toString("hex");

describe("crypto", () => {
  beforeEach(() => {
    process.env.SECRETS_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  });

  afterEach(() => {
    delete process.env.SECRETS_ENCRYPTION_KEY;
  });

  it("encrypts and decrypts a secret correctly", () => {
    const plaintext = "my-secret-key-abc123";
    const encrypted = encryptSecret(plaintext);
    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it("produces encrypted output different from plaintext", () => {
    const plaintext = "my-secret-key-abc123";
    const encrypted = encryptSecret(plaintext);
    expect(encrypted).not.toBe(plaintext);
  });

  it("produces encrypted output in iv:authTag:ciphertext format", () => {
    const plaintext = "my-secret-key-abc123";
    const encrypted = encryptSecret(plaintext);
    const parts = encrypted.split(":");
    expect(parts.length).toBe(3);
    // IV is 12 bytes = 24 hex chars
    expect(parts[0].length).toBe(24);
    // Auth tag is 16 bytes = 32 hex chars
    expect(parts[1].length).toBe(32);
    // Ciphertext length varies
    expect(parts[2].length).toBeGreaterThan(0);
  });

  it("produces different ciphertexts for same plaintext (due to random IV)", () => {
    const plaintext = "my-secret-key-abc123";
    const encrypted1 = encryptSecret(plaintext);
    const encrypted2 = encryptSecret(plaintext);
    expect(encrypted1).not.toBe(encrypted2);

    // But both decrypt to the same value
    expect(decryptSecret(encrypted1)).toBe(plaintext);
    expect(decryptSecret(encrypted2)).toBe(plaintext);
  });

  it("throws error when SECRETS_ENCRYPTION_KEY is not set", () => {
    delete process.env.SECRETS_ENCRYPTION_KEY;
    expect(() => encryptSecret("test")).toThrow(
      "SECRETS_ENCRYPTION_KEY must be set"
    );
  });

  it("throws error when SECRETS_ENCRYPTION_KEY is wrong length", () => {
    process.env.SECRETS_ENCRYPTION_KEY = "too-short";
    expect(() => encryptSecret("test")).toThrow(
      "SECRETS_ENCRYPTION_KEY must be set"
    );
  });

  it("throws error when decrypting with wrong key", () => {
    const plaintext = "my-secret";
    const encrypted = encryptSecret(plaintext);

    // Change the encryption key
    process.env.SECRETS_ENCRYPTION_KEY = randomBytes(32).toString("hex");
    expect(() => decryptSecret(encrypted)).toThrow();
  });

  it("throws error for invalid encrypted format", () => {
    expect(() => decryptSecret("not-valid-format")).toThrow(
      "Invalid encrypted secret format"
    );
  });

  it("handles empty string encryption", () => {
    const plaintext = "";
    const encrypted = encryptSecret(plaintext);
    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it("handles long secrets", () => {
    const plaintext = randomBytes(256).toString("hex");
    const encrypted = encryptSecret(plaintext);
    const decrypted = decryptSecret(encrypted);
    expect(decrypted).toBe(plaintext);
  });
});
