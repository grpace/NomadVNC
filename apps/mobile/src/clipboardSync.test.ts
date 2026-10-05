import { describe, expect, it } from "vitest";
import { clipboardPolicyFor, clipboardTextToPaste } from "./clipboardSync";

describe("clipboardTextToPaste", () => {
  it("returns new non-empty text", () => {
    expect(clipboardTextToPaste("", "hello")).toBe("hello");
    expect(clipboardTextToPaste("old", "new")).toBe("new");
  });

  it("returns null for empty or unchanged text", () => {
    expect(clipboardTextToPaste("", "")).toBeNull();
    expect(clipboardTextToPaste("same", "same")).toBeNull();
  });

  it("returns null for null/undefined clipboard reads", () => {
    expect(clipboardTextToPaste("x", null)).toBeNull();
    expect(clipboardTextToPaste("x", undefined)).toBeNull();
  });

  it("treats text we just wrote remotely as seen (no echo)", () => {
    // Remote → local write records the text as last-seen; the next poll
    // must not paste it back into the remote session.
    const written = "copied on the server";
    expect(clipboardTextToPaste(written, written)).toBeNull();
  });
});

describe("clipboardPolicyFor", () => {
  it("reads automatically on Android but asks first on iOS", () => {
    expect(clipboardPolicyFor("android")).toBe("auto");
    expect(clipboardPolicyFor("ios")).toBe("offer");
  });
});
