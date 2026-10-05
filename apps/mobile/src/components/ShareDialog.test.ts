import { describe, expect, it } from "vitest";
import {
  parseShareDays,
  SHARE_MAX_KEY_DAYS,
  SHARE_WARN_WITHIN_DAYS,
  shareExpiryLabel,
} from "./shareExpiry";
import type { BackendShareView } from "../account/accountClient";

function share(overrides: Partial<BackendShareView>): BackendShareView {
  return {
    id: "s1",
    deviceId: "d1",
    granteeEmail: "friend@example.com",
    permission: "connect",
    hasTailnetKey: false,
    keyExpiresInDays: null,
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("shareExpiryLabel", () => {
  it("same-tailnet shares never expire", () => {
    expect(shareExpiryLabel(share({ hasTailnetKey: false }))).toEqual({
      text: "Same-tailnet · never expires",
      tone: "plain",
    });
  });

  it("reports attached key without expiry", () => {
    expect(
      shareExpiryLabel(share({ hasTailnetKey: true, keyExpiresInDays: null })),
    ).toEqual({ text: "Tailnet key attached", tone: "ok" });
  });

  it("flags expired keys", () => {
    const label = shareExpiryLabel(
      share({ hasTailnetKey: true, keyExpiresInDays: 0 }),
    );
    expect(label.tone).toBe("bad");
    expect(label.text).toContain("expired");
  });

  it("warns within the warning window", () => {
    for (const days of [1, SHARE_WARN_WITHIN_DAYS]) {
      const label = shareExpiryLabel(
        share({ hasTailnetKey: true, keyExpiresInDays: days }),
      );
      expect(label.tone).toBe("warn");
      expect(label.text).toContain("Replace soon");
    }
  });

  it("ok beyond the warning window", () => {
    const label = shareExpiryLabel(
      share({ hasTailnetKey: true, keyExpiresInDays: SHARE_WARN_WITHIN_DAYS + 1 }),
    );
    expect(label.tone).toBe("ok");
    expect(label.text).toContain("expires in");
  });
});

describe("parseShareDays", () => {
  it("accepts 1–90 whole days", () => {
    expect(parseShareDays("1")).toBe(1);
    expect(parseShareDays("30")).toBe(30);
    expect(parseShareDays(String(SHARE_MAX_KEY_DAYS))).toBe(SHARE_MAX_KEY_DAYS);
  });

  it("rejects out-of-range and non-integer input", () => {
    expect(parseShareDays("0")).toBeNull();
    expect(parseShareDays("91")).toBeNull();
    expect(parseShareDays("2.5")).toBeNull();
    expect(parseShareDays("")).toBeNull();
    expect(parseShareDays("abc")).toBeNull();
  });
});
