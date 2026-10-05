import { describe, expect, it } from "vitest";
import { decodeAccountEmail, extractMagicToken } from "./accountSession";

function fakeJwt(email: string): string {
  const encode = (value: string): string =>
    btoa(unescape(encodeURIComponent(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode('{"alg":"HS256"}')}.${encode(JSON.stringify({ sub: "u-1", email }))}.sig`;
}

describe("accountSession", () => {
  it("extracts the token from a full magic-link URL", () => {
    expect(
      extractMagicToken("https://app.example.test/auth/verify?token=abc123DEF-_456"),
    ).toBe("abc123DEF-_456");
  });

  it("extracts the token from a nomadvnc:// deep link", () => {
    expect(
      extractMagicToken("nomadvnc://auth/callback?token=abc123DEF-_456"),
    ).toBe("abc123DEF-_456");
  });

  it("accepts a raw token", () => {
    expect(extractMagicToken("  abc123DEF-_4567890  ")).toBe("abc123DEF-_4567890");
  });

  it("rejects blanks and junk", () => {
    expect(extractMagicToken("")).toBeNull();
    expect(extractMagicToken("   ")).toBeNull();
    expect(extractMagicToken("not a token!!")).toBeNull();
    expect(extractMagicToken("https://app.example.test/auth/verify")).toBeNull();
  });

  it("decodes the display email from a JWT", () => {
    expect(decodeAccountEmail(fakeJwt("alice@example.test"))).toBe("alice@example.test");
  });

  it("returns null for malformed tokens", () => {
    expect(decodeAccountEmail("")).toBeNull();
    expect(decodeAccountEmail("a.b")).toBeNull();
    expect(decodeAccountEmail("a.b.c")).toBeNull();
    expect(decodeAccountEmail(fakeJwt(""))).toBeNull();
  });
});
