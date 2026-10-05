import { describe, expect, it, vi } from "vitest";
import {
  isKeyboardGrabSupported,
  releaseKeyboardGrab,
  requestKeyboardGrab,
} from "./keyboardGrab";

function mockKeyboard(lockImpl?: () => Promise<void>) {
  const lock = vi.fn(lockImpl ?? (async () => {}));
  const unlock = vi.fn(() => {});
  Object.defineProperty(window.navigator, "keyboard", {
    value: { lock, unlock },
    configurable: true,
  });
  return { lock, unlock };
}

function unmockKeyboard() {
  const nav = window.navigator as Navigator & { keyboard?: unknown };
  if ("keyboard" in nav) {
    delete nav.keyboard;
  }
}

describe("keyboardGrab", () => {
  it("reports unsupported when the Keyboard Lock API is absent", async () => {
    unmockKeyboard();
    expect(isKeyboardGrabSupported()).toBe(false);
    expect(await requestKeyboardGrab()).toBe(false);
    expect(() => releaseKeyboardGrab()).not.toThrow();
  });

  it("locks and reports success when the API resolves", async () => {
    const { lock } = mockKeyboard();
    try {
      expect(isKeyboardGrabSupported()).toBe(true);
      expect(await requestKeyboardGrab()).toBe(true);
      expect(lock).toHaveBeenCalledTimes(1);
    } finally {
      unmockKeyboard();
    }
  });

  it("reports failure when the API rejects", async () => {
    mockKeyboard(async () => {
      throw new DOMException("Not allowed", "NotAllowedError");
    });
    try {
      expect(await requestKeyboardGrab()).toBe(false);
    } finally {
      unmockKeyboard();
    }
  });

  it("unlocks through the API when present", () => {
    const { unlock } = mockKeyboard();
    try {
      releaseKeyboardGrab();
      expect(unlock).toHaveBeenCalledTimes(1);
    } finally {
      unmockKeyboard();
    }
  });
});
