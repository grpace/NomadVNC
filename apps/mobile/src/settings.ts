import { NomadNativeModule } from "./native/NomadNativeModule";
import type { PointerMode } from "@nomadvnc/viewer-shell";
import { isDisplayRegion, type DisplayRegion } from "./displayRegion";

/** Thin promise wrapper over the native key-value store (SharedPreferences/UserDefaults). */
const NativeStorage = {
  async getItem(key: string): Promise<string | null> {
    return NomadNativeModule.storageGetItem(key);
  },
  async setItem(key: string, value: string): Promise<void> {
    await NomadNativeModule.storageSetItem(key, value);
  },
  async removeItem(key: string): Promise<void> {
    await NomadNativeModule.storageRemoveItem(key);
  },
};

export type MobileScaleMode = "fit" | "actual";

export interface MobileSettings {
  /** noVNC quality level 0–9 (desktop parity: 2=Low, 5=Medium, 8=High, 9=Lossless). */
  quality: number;
  /** Auto-degrade quality on slow connections (desktop parity). */
  autoQuality: boolean;
  scaleMode: MobileScaleMode;
  /** Prefilled when adding a device (desktop parity). */
  defaultVncPort: number;
  /** Touch input: tap where you point ("touch") or a laptop-style trackpad. */
  pointerMode: PointerMode;
  /** Two-way clipboard sync with the remote machine. */
  clipboardSync: boolean;
  /** The first-session gestures tip has been shown. */
  gestureTipSeen: boolean;
  /**
   * Tailnet name for this phone. Empty uses the automatic name
   * (NomadVNC- plus the device name, never localhost).
   */
  tailscaleHostname: string;
}

export const DEFAULT_MOBILE_SETTINGS: MobileSettings = {
  quality: 6,
  autoQuality: true,
  scaleMode: "fit",
  defaultVncPort: 5900,
  pointerMode: "touch",
  clipboardSync: true,
  gestureTipSeen: false,
  tailscaleHostname: "",
};

export const QUALITY_OPTIONS = [
  { value: 6, label: "Auto (Balanced)" },
  { value: 2, label: "Low" },
  { value: 5, label: "Medium" },
  { value: 8, label: "High" },
  { value: 9, label: "Lossless" },
] as const;

const STORAGE_KEY = "nomadvnc.mobile.settings.v1";

function sanitize(raw: Partial<MobileSettings>): MobileSettings {
  const quality =
    typeof raw.quality === "number" && raw.quality >= 0 && raw.quality <= 9
      ? Math.round(raw.quality)
      : DEFAULT_MOBILE_SETTINGS.quality;
  const scaleMode =
    raw.scaleMode === "actual" || raw.scaleMode === "fit"
      ? raw.scaleMode
      : DEFAULT_MOBILE_SETTINGS.scaleMode;
  const defaultVncPort =
    typeof raw.defaultVncPort === "number" &&
    Number.isInteger(raw.defaultVncPort) &&
    raw.defaultVncPort >= 1 &&
    raw.defaultVncPort <= 65535
      ? raw.defaultVncPort
      : DEFAULT_MOBILE_SETTINGS.defaultVncPort;
  return {
    quality,
    autoQuality:
      typeof raw.autoQuality === "boolean"
        ? raw.autoQuality
        : DEFAULT_MOBILE_SETTINGS.autoQuality,
    scaleMode,
    defaultVncPort,
    pointerMode: raw.pointerMode === "trackpad" ? "trackpad" : "touch",
    clipboardSync:
      typeof raw.clipboardSync === "boolean"
        ? raw.clipboardSync
        : DEFAULT_MOBILE_SETTINGS.clipboardSync,
    gestureTipSeen: raw.gestureTipSeen === true,
    tailscaleHostname:
      typeof raw.tailscaleHostname === "string" ? raw.tailscaleHostname.trim().slice(0, 63) : "",
  };
}

export async function loadMobileSettings(): Promise<MobileSettings> {
  try {
    const raw = await NativeStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_MOBILE_SETTINGS };
    return sanitize(JSON.parse(raw) as Partial<MobileSettings>);
  } catch {
    return { ...DEFAULT_MOBILE_SETTINGS };
  }
}

export async function saveMobileSettings(settings: MobileSettings): Promise<void> {
  await NativeStorage.setItem(STORAGE_KEY, JSON.stringify(sanitize(settings)));
}

/** Loads, merges, and saves (for changes made outside the Settings screen). */
export async function updateMobileSettings(
  partial: Partial<MobileSettings>,
): Promise<MobileSettings> {
  const next = { ...(await loadMobileSettings()), ...partial };
  try {
    await saveMobileSettings(next);
  } catch {
    // Best-effort: the in-memory value still applies this session.
  }
  return next;
}

export function qualityLabelFor(quality: number): string {
  const found = QUALITY_OPTIONS.find((o) => o.value === quality);
  return found ? found.label : `Level ${quality}`;
}

/** Per-device viewer overrides (desktop parity: machineViewPrefs, mobile slice). */
export interface DeviceViewPrefs {
  quality?: number;
  scaleMode?: MobileScaleMode;
  displayRegion?: DisplayRegion;
}

const DEVICE_PREFS_KEY = "nomadvnc.mobile.deviceViewPrefs.v1";

function sanitizeDevicePrefs(raw: unknown): DeviceViewPrefs {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: DeviceViewPrefs = {};
  if (typeof r.quality === "number" && r.quality >= 0 && r.quality <= 9) {
    out.quality = Math.round(r.quality);
  }
  if (r.scaleMode === "fit" || r.scaleMode === "actual") {
    out.scaleMode = r.scaleMode;
  }
  if (isDisplayRegion(r.displayRegion)) {
    out.displayRegion = r.displayRegion;
  }
  return out;
}

export async function loadDeviceViewPrefs(
  deviceId: string,
): Promise<DeviceViewPrefs> {
  try {
    const raw = await NativeStorage.getItem(DEVICE_PREFS_KEY);
    if (!raw) return {};
    const map = JSON.parse(raw) as Record<string, unknown>;
    return sanitizeDevicePrefs(map[deviceId]);
  } catch {
    return {};
  }
}

export async function saveDeviceViewPrefs(
  deviceId: string,
  prefs: DeviceViewPrefs,
): Promise<void> {
  try {
    const raw = await NativeStorage.getItem(DEVICE_PREFS_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    map[deviceId] = sanitizeDevicePrefs(prefs);
    await NativeStorage.setItem(DEVICE_PREFS_KEY, JSON.stringify(map));
  } catch {
    // Best-effort.
  }
}

/** Effective prefs: per-device overrides win over global settings. */
export function effectiveViewPrefs(
  global: MobileSettings,
  device: DeviceViewPrefs,
): { quality: number; scaleMode: MobileScaleMode; displayRegion: DisplayRegion } {
  return {
    quality: device.quality ?? global.quality,
    scaleMode: device.scaleMode ?? global.scaleMode,
    displayRegion: device.displayRegion ?? "full",
  };
}

/**
 * The last manual connection (address, port, username — never the
 * password), so returning from a session doesn't mean retyping it all.
 */
export interface LastManualConnection {
  host: string;
  port: string;
  username?: string;
}

const LAST_MANUAL_KEY = "nomadvnc.mobile.lastManualConnection.v1";

export function sanitizeLastManualConnection(raw: unknown): LastManualConnection | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const host = typeof r.host === "string" ? r.host.trim() : "";
  const port = typeof r.port === "string" && /^\d{1,5}$/.test(r.port) ? r.port : "";
  if (!host || !port) return null;
  const username = typeof r.username === "string" && r.username.trim() ? r.username.trim() : undefined;
  return username ? { host, port, username } : { host, port };
}

export async function loadLastManualConnection(): Promise<LastManualConnection | null> {
  try {
    const raw = await NativeStorage.getItem(LAST_MANUAL_KEY);
    return raw ? sanitizeLastManualConnection(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export async function saveLastManualConnection(connection: LastManualConnection): Promise<void> {
  const clean = sanitizeLastManualConnection(connection);
  if (!clean) return;
  try {
    await NativeStorage.setItem(LAST_MANUAL_KEY, JSON.stringify(clean));
  } catch {
    // Convenience only; never block a connection on it.
  }
}
