import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_APP_SETTINGS,
  defaultViewPrefsFromSettings,
  loadAppSettings,
  persistAppSettings,
  sanitizeAppSettings,
} from "./appSettings";
import { DEFAULT_MACHINE_VIEW_PREFS } from "./machineViewPrefs";

const STORAGE_KEY = "nomadvnc.desktop.appSettings.v1";

describe("sanitizeAppSettings", () => {
  it("falls back to defaults for missing or corrupt input", () => {
    expect(sanitizeAppSettings(undefined)).toEqual(DEFAULT_APP_SETTINGS);
    expect(sanitizeAppSettings(null)).toEqual(DEFAULT_APP_SETTINGS);
    expect(sanitizeAppSettings("nope")).toEqual(DEFAULT_APP_SETTINGS);
    expect(sanitizeAppSettings({})).toEqual(DEFAULT_APP_SETTINGS);
  });

  it("rejects out-of-range ports and qualities", () => {
    const sanitized = sanitizeAppSettings({
      defaultVncPort: 99999,
      defaultQuality: 7,
      defaultScaleMode: "sideways",
    });
    expect(sanitized.defaultVncPort).toBe(DEFAULT_APP_SETTINGS.defaultVncPort);
    expect(sanitized.defaultQuality).toBe(DEFAULT_APP_SETTINGS.defaultQuality);
    expect(sanitized.defaultScaleMode).toBe(DEFAULT_APP_SETTINGS.defaultScaleMode);
  });

  it("accepts valid overrides", () => {
    const sanitized = sanitizeAppSettings({
      defaultVncPort: 5901,
      defaultScaleMode: "actual",
      defaultQuality: 9,
      defaultAutoQuality: false,
      defaultCaptureKeys: true,
    });
    expect(sanitized).toEqual({
      defaultVncPort: 5901,
      defaultScaleMode: "actual",
      defaultQuality: 9,
      defaultAutoQuality: false,
      defaultCaptureKeys: true,
      tailscaleHostname: "",
    });
  });
});

describe("loadAppSettings / persistAppSettings", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("round-trips through localStorage", () => {
    persistAppSettings({ ...DEFAULT_APP_SETTINGS, defaultVncPort: 5902 });
    expect(loadAppSettings().defaultVncPort).toBe(5902);
  });

  it("returns defaults when nothing is stored or storage is corrupt", () => {
    expect(loadAppSettings()).toEqual(DEFAULT_APP_SETTINGS);
    window.localStorage.setItem(STORAGE_KEY, "{not json");
    expect(loadAppSettings()).toEqual(DEFAULT_APP_SETTINGS);
  });

  it("sanitizes on write so storage never holds invalid settings", () => {
    persistAppSettings({ ...DEFAULT_APP_SETTINGS, defaultVncPort: -1 });
    expect(loadAppSettings().defaultVncPort).toBe(DEFAULT_APP_SETTINGS.defaultVncPort);
  });
});

describe("defaultViewPrefsFromSettings", () => {
  it("layers app defaults over the built-in view prefs", () => {
    const prefs = defaultViewPrefsFromSettings({
      ...DEFAULT_APP_SETTINGS,
      defaultScaleMode: "actual",
      defaultQuality: 9,
      defaultAutoQuality: false,
      defaultCaptureKeys: true,
    });
    expect(prefs.scaleMode).toBe("actual");
    expect(prefs.quality).toBe(9);
    expect(prefs.autoQuality).toBe(false);
    expect(prefs.captureKeys).toBe(true);
    // Untouched keys keep built-in defaults.
    expect(prefs.displayRegion).toBe(DEFAULT_MACHINE_VIEW_PREFS.displayRegion);
    expect(prefs.zoomLevel).toBe(DEFAULT_MACHINE_VIEW_PREFS.zoomLevel);
  });
});
