import { describe, expect, it, vi } from "vitest";

// react-native-keychain is a native module; stub it so the import in
// accountSession.ts resolves under vitest. These tests inject an in-memory
// SecureStore and never touch the real Keychain.
vi.mock("react-native-keychain", () => ({
  getGenericPassword: vi.fn(async () => false),
  setGenericPassword: vi.fn(async () => true),
  resetGenericPassword: vi.fn(async () => true),
}));

import {
  clearSession,
  decodeAccountEmail,
  extractMagicToken,
  createMagicLinkGate,
  magicLinkFromUrl,
  loadSession,
  saveSession,
  type SecureStore,
} from "./accountSession";
import {
  DEFAULT_ACCOUNT_BASE_URL,
  isValidAccountBaseUrl,
  loadAccountConfig,
  persistAccountConfig,
} from "./accountConfig";

function memoryStore(): SecureStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(key: string) {
      return data.get(key) ?? null;
    },
    async set(key: string, value: string) {
      data.set(key, value);
    },
    async del(key: string) {
      data.delete(key);
    },
  };
}

/** Minimal unsigned JWT with {"email":"user@example.test"} payload. */
function fakeJwt(email: string): string {
  const b64url = (s: string) =>
    Buffer.from(s, "utf8")
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `header.${b64url(JSON.stringify({ email }))}.sig`;
}

describe("extractMagicToken", () => {
  it("pulls the token from the deep-link URL", () => {
    expect(extractMagicToken("nomadvnc://auth/callback?token=abc123XYZ_-456")).toBe("abc123XYZ_-456");
  });

  it("pulls the token from an https verify URL", () => {
    expect(extractMagicToken("https://api.example.test/verify?token=tok_789")).toBe("tok_789");
  });

  it("accepts a raw token", () => {
    expect(extractMagicToken("  rawToken_1234567890  ")).toBe("rawToken_1234567890");
  });

  it("rejects blanks and junk", () => {
    expect(extractMagicToken("")).toBeNull();
    expect(extractMagicToken("   ")).toBeNull();
    expect(extractMagicToken("not a token!!")).toBeNull();
    expect(extractMagicToken("nomadvnc://auth/callback")).toBeNull();
  });

  it("finds the token inside the email text, including a wrapped link", () => {
    const body = [
      "Sign in to NomadVNC (expires in 15 minutes):",
      "https://api.example.test/auth/open?token=abc123XYZ_-456",
      "",
      "copy this link and paste it into the sign-in box:",
      "nomadvnc://auth/callback?token=abc123XYZ_",
      "-456",
    ].join("\n");
    expect(extractMagicToken(body)).toBe("abc123XYZ_-456");
  });

  it("reads a token when URL accessors throw, as they do in React Native", () => {
    const Original = globalThis.URL;
    class BrokenURL {
      constructor(_url: string, _base?: string) {}
      get protocol(): string {
        throw new Error("URL.protocol is not implemented");
      }
      get searchParams(): { get(name: string): string | null } {
        return {
          get(): string | null {
            throw new Error("URLSearchParams.get is not implemented");
          },
        };
      }
    }
    globalThis.URL = BrokenURL as unknown as typeof URL;
    try {
      expect(extractMagicToken("nomadvnc://auth/callback?token=abc123XYZ_-456")).toBe(
        "abc123XYZ_-456",
      );
      expect(magicLinkFromUrl("nomadvnc://auth/callback?token=abc123XYZ_-456")).toBe(
        "abc123XYZ_-456",
      );
      expect(extractMagicToken("https://api.example.test/auth/open?token=abc123XYZ_-456")).toBe(
        "abc123XYZ_-456",
      );
    } finally {
      globalThis.URL = Original;
    }
  });
});

describe("magicLinkFromUrl", () => {
  it("accepts the sign-in deep link and ignores other URLs", () => {
    expect(magicLinkFromUrl("nomadvnc://auth/callback?token=abc123XYZ_-456")).toBe("abc123XYZ_-456");
    expect(magicLinkFromUrl("nomadvnc:///auth/callback?token=abc123XYZ_-456")).toBe("abc123XYZ_-456");
    expect(magicLinkFromUrl("https://app.example.test/auth/open?token=abc123XYZ_-456")).toBeNull();
    expect(magicLinkFromUrl("nomadvnc://other?token=abc123XYZ_-456")).toBeNull();
    expect(magicLinkFromUrl("not a url")).toBeNull();
  });
});

describe("createMagicLinkGate", () => {
  it("runs one attempt while the same token is already in flight", async () => {
    const gate = createMagicLinkGate();
    let started = 0;
    let release: () => void = () => {};
    const task = () => {
      started += 1;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const first = gate.run("tok", task);
    const second = gate.run("tok", task);
    expect(started).toBe(1);
    release();
    await first;
    await second;
    expect(started).toBe(1);
  });

  it("allows another attempt after the first one fails", async () => {
    const gate = createMagicLinkGate();
    let started = 0;
    await expect(
      gate.run("tok", async () => {
        started += 1;
        throw new Error("offline");
      }),
    ).rejects.toThrow("offline");
    await gate.run("tok", async () => {
      started += 1;
    });
    expect(started).toBe(2);
  });
});

describe("decodeAccountEmail", () => {
  it("reads the email from the JWT payload without verifying", () => {
    expect(decodeAccountEmail(fakeJwt("user@example.test"))).toBe("user@example.test");
  });

  it("handles unicode emails via the hand-rolled utf8 decoder", () => {
    expect(decodeAccountEmail(fakeJwt("bäy-1@example.test"))).toBe("bäy-1@example.test");
  });

  it("returns null for malformed tokens", () => {
    expect(decodeAccountEmail("not-a-jwt")).toBeNull();
    expect(decodeAccountEmail("a.b")).toBeNull();
    expect(decodeAccountEmail("a.!!!.c")).toBeNull();
  });
});

describe("session persistence", () => {
  it("round-trips a session through the store", async () => {
    const store = memoryStore();
    expect(await loadSession(store)).toBeNull();
    const token = fakeJwt("owner@example.test");
    await saveSession({ token, email: "owner@example.test" }, store);
    expect(await loadSession(store)).toEqual({ token, email: "owner@example.test" });
    await clearSession(store);
    expect(await loadSession(store)).toBeNull();
  });

  it("prefers the email decoded from the token over a stale stored email", async () => {
    const store = memoryStore();
    const token = fakeJwt("new@example.test");
    await saveSession({ token, email: "old@example.test" }, store);
    expect(await loadSession(store)).toEqual({ token, email: "new@example.test" });
  });

  it("fails closed on corrupt storage", async () => {
    const store = memoryStore();
    store.data.set("nomadvnc.account.session.v1", "{not json");
    expect(await loadSession(store)).toBeNull();
  });
});

describe("account config", () => {
  it("defaults to the hosted backend", async () => {
    expect(await loadAccountConfig(memoryStore())).toEqual({ baseUrl: DEFAULT_ACCOUNT_BASE_URL });
  });

  it("persists a valid override and sanitizes it", async () => {
    const store = memoryStore();
    await persistAccountConfig({ baseUrl: "http://192.168.1.10:3200///" }, store);
    expect(await loadAccountConfig(store)).toEqual({ baseUrl: "http://192.168.1.10:3200" });
  });

  it("falls back to default for invalid values", async () => {
    const store = memoryStore();
    await persistAccountConfig({ baseUrl: "not a url" }, store);
    expect(await loadAccountConfig(store)).toEqual({ baseUrl: DEFAULT_ACCOUNT_BASE_URL });
  });

  it("validates base URLs", () => {
    expect(isValidAccountBaseUrl("https://api.example.test")).toBe(true);
    expect(isValidAccountBaseUrl("http://10.0.0.2:3200")).toBe(true);
    expect(isValidAccountBaseUrl("ftp://x.test")).toBe(false);
    expect(isValidAccountBaseUrl("https://")).toBe(false);
  });
});
