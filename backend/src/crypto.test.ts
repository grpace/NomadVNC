import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decryptCredential,
  decryptShareKey,
  encryptCredential,
  encryptShareKey,
  fingerprintKey,
  parseDataKey,
  type DataKey,
} from "./crypto.js";

function testKey(seed: string): DataKey {
  const key = crypto.createHash("sha256").update(seed).digest();
  return { id: fingerprintKey(key), key };
}

describe("credential envelope", () => {
  it("round-trips a password", () => {
    const key = testKey("primary");
    const envelope = encryptCredential(key, "device-1", "owner-1", "s3cret-vnc!");
    expect(decryptCredential([key], "device-1", "owner-1", envelope)).toBe("s3cret-vnc!");
  });

  it("rejects wrong keys, devices, and owners", () => {
    const key = testKey("primary");
    const envelope = encryptCredential(key, "device-1", "owner-1", "s3cret");
    expect(() => decryptCredential([testKey("other")], "device-1", "owner-1", envelope)).toThrow();
    expect(() => decryptCredential([key], "device-2", "owner-1", envelope)).toThrow();
    expect(() => decryptCredential([key], "device-1", "owner-2", envelope)).toThrow();
  });

  it("rejects tampered ciphertext and malformed envelopes", () => {
    const key = testKey("primary");
    const envelope = encryptCredential(key, "device-1", "owner-1", "s3cret");
    const tampered = { ...envelope, ciphertext: envelope.ciphertext.slice(0, -4) + "AAAA" };
    expect(() => decryptCredential([key], "device-1", "owner-1", tampered)).toThrow();
    expect(() => decryptCredential([key], "device-1", "owner-1", { ...envelope, nonce: "nope" })).toThrow();
  });

  it("uses fresh nonces and falls back across rotation", () => {
    const oldKey = testKey("old");
    const newKey = testKey("new");
    const first = encryptCredential(oldKey, "device-1", "owner-1", "s3cret");
    const second = encryptCredential(oldKey, "device-1", "owner-1", "s3cret");
    expect(first.nonce).not.toBe(second.nonce);
    // Old envelope still opens once the new key is loaded alongside the old.
    expect(decryptCredential([newKey, oldKey], "device-1", "owner-1", first)).toBe("s3cret");
  });

  it("parses 32-byte keys and rejects the rest", () => {
    expect(parseDataKey("00".repeat(32))).toHaveLength(32);
    expect(parseDataKey(Buffer.alloc(32, 7).toString("base64"))).toHaveLength(32);
    expect(() => parseDataKey("too-short")).toThrow();
    expect(() => parseDataKey("")).toThrow();
  });
});

describe("share-key envelope", () => {
  it("round-trips a tailnet auth key", () => {
    const key = testKey("primary");
    const envelope = encryptShareKey(key, "share-1", "device-1", "tskey-auth-abc123");
    expect(decryptShareKey([key], "share-1", "device-1", envelope)).toBe("tskey-auth-abc123");
  });

  it("binds the seal to its share and device", () => {
    const key = testKey("primary");
    const envelope = encryptShareKey(key, "share-1", "device-1", "tskey-auth-abc123");
    expect(() => decryptShareKey([key], "share-2", "device-1", envelope)).toThrow();
    expect(() => decryptShareKey([key], "share-1", "device-2", envelope)).toThrow();
    expect(() => decryptShareKey([testKey("other")], "share-1", "device-1", envelope)).toThrow();
  });

  it("falls back across rotation", () => {
    const oldKey = testKey("old");
    const newKey = testKey("new");
    const envelope = encryptShareKey(oldKey, "share-1", "device-1", "tskey-auth-abc123");
    expect(decryptShareKey([newKey, oldKey], "share-1", "device-1", envelope)).toBe("tskey-auth-abc123");
  });
});
