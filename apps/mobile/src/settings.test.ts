import { describe, expect, it, vi } from "vitest";

vi.mock("./native/NomadNativeModule", () => ({
  NomadNativeModule: {
    storageGetItem: vi.fn().mockResolvedValue(null),
    storageSetItem: vi.fn().mockResolvedValue(undefined),
    storageRemoveItem: vi.fn().mockResolvedValue(undefined),
  },
}));

import { NomadNativeModule } from "./native/NomadNativeModule";
import {
  DEFAULT_MOBILE_SETTINGS,
  effectiveViewPrefs,
  loadMobileSettings,
  qualityLabelFor,
  sanitizeLastManualConnection,
  type DeviceViewPrefs,
  type MobileSettings,
} from "./settings";

// sanitize is module-private; exercise it through the public surface by
// re-implementing the shape contract here would couple to internals, so we
// test the pure label helper and the defaults object instead.

describe("mobile settings", () => {
  it("has sane defaults", () => {
    const d: MobileSettings = DEFAULT_MOBILE_SETTINGS;
    expect(d.quality).toBeGreaterThanOrEqual(0);
    expect(d.quality).toBeLessThanOrEqual(9);
    expect(d.autoQuality).toBe(true);
    expect(["fit", "actual"]).toContain(d.scaleMode);
    expect(d.defaultVncPort).toBe(5900);
  });

  it("labels known quality levels", () => {
    expect(qualityLabelFor(2)).toBe("Low");
    expect(qualityLabelFor(5)).toBe("Medium");
    expect(qualityLabelFor(8)).toBe("High");
    expect(qualityLabelFor(9)).toBe("Lossless");
    expect(qualityLabelFor(6)).toBe("Auto (Balanced)");
  });

  it("falls back for unknown levels", () => {
    expect(qualityLabelFor(3)).toBe("Level 3");
  });

  it("defaults to touch mode with clipboard sync on", () => {
    expect(DEFAULT_MOBILE_SETTINGS.pointerMode).toBe("touch");
    expect(DEFAULT_MOBILE_SETTINGS.clipboardSync).toBe(true);
    expect(DEFAULT_MOBILE_SETTINGS.gestureTipSeen).toBe(false);
  });

  it("loads saved input settings and rejects bad values", async () => {
    const getItem = vi.mocked(NomadNativeModule.storageGetItem);
    getItem.mockResolvedValueOnce(
      JSON.stringify({ pointerMode: "trackpad", clipboardSync: false, gestureTipSeen: true }),
    );
    expect(await loadMobileSettings()).toMatchObject({
      pointerMode: "trackpad",
      clipboardSync: false,
      gestureTipSeen: true,
    });
    getItem.mockResolvedValueOnce(JSON.stringify({ pointerMode: "laser", clipboardSync: "yes" }));
    expect(await loadMobileSettings()).toMatchObject({
      pointerMode: "touch",
      clipboardSync: true,
      gestureTipSeen: false,
    });
  });
});

describe("effectiveViewPrefs", () => {
  const global: MobileSettings = {
    ...DEFAULT_MOBILE_SETTINGS,
    quality: 8,
    scaleMode: "fit",
  };

  it("uses global settings when no device overrides", () => {
    expect(effectiveViewPrefs(global, {})).toEqual({
      quality: 8,
      scaleMode: "fit",
      displayRegion: "full",
    });
  });

  it("device overrides win over global", () => {
    const device: DeviceViewPrefs = { quality: 2, scaleMode: "actual", displayRegion: "left" };
    expect(effectiveViewPrefs(global, device)).toEqual({
      quality: 2,
      scaleMode: "actual",
      displayRegion: "left",
    });
  });

  it("partial overrides merge with global", () => {
    expect(effectiveViewPrefs(global, { quality: 5 })).toEqual({
      quality: 5,
      scaleMode: "fit",
      displayRegion: "full",
    });
  });
});

describe("last manual connection", () => {
  it("keeps address, port, and username but never a password", () => {
    expect(
      sanitizeLastManualConnection({ host: " 192.168.1.20 ", port: "5901", username: "greg", password: "nope" }),
    ).toEqual({ host: "192.168.1.20", port: "5901", username: "greg" });
  });

  it("rejects incomplete or malformed entries", () => {
    expect(sanitizeLastManualConnection({ host: "", port: "5900" })).toBeNull();
    expect(sanitizeLastManualConnection({ host: "pc", port: "59x" })).toBeNull();
    expect(sanitizeLastManualConnection(null)).toBeNull();
  });
});
