import {
  DEFAULT_MACHINE_VIEW_PREFS,
  type MachineScaleMode,
  type MachineViewPrefs,
} from "./machineViewPrefs";

/**
 * App-level settings: defaults for new machines and for viewers that have
 * no per-machine prefs yet, plus anything else global. Local-only
 * (localStorage); nothing here needs a Nomad account.
 */
export interface AppSettings {
  /** Prefilled VNC port on the new-machine form. */
  defaultVncPort: number;
  /** Viewer defaults applied until a machine gets its own prefs. */
  defaultScaleMode: MachineScaleMode;
  defaultQuality: number;
  defaultAutoQuality: boolean;
  defaultCaptureKeys: boolean;
  /**
   * Tailnet name for this computer. Empty uses NomadVNC- plus the
   * computer name.
   */
  tailscaleHostname: string;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  defaultVncPort: 5900,
  defaultScaleMode: "fit",
  defaultQuality: 6,
  defaultAutoQuality: true,
  defaultCaptureKeys: false,
  tailscaleHostname: "",
};

const STORAGE_KEY = "nomadvnc.desktop.appSettings.v1";

const VALID_SCALE_MODES: MachineScaleMode[] = ["fit", "actual", "zoom"];
const VALID_QUALITIES = [2, 5, 6, 8, 9];

export function sanitizeAppSettings(value: unknown): AppSettings {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_APP_SETTINGS };
  }
  const candidate = value as Partial<AppSettings>;
  const port = candidate.defaultVncPort;
  const defaultVncPort =
    typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535
      ? port
      : DEFAULT_APP_SETTINGS.defaultVncPort;
  const defaultScaleMode = VALID_SCALE_MODES.includes(candidate.defaultScaleMode as MachineScaleMode)
    ? (candidate.defaultScaleMode as MachineScaleMode)
    : DEFAULT_APP_SETTINGS.defaultScaleMode;
  const defaultQuality =
    typeof candidate.defaultQuality === "number" && VALID_QUALITIES.includes(candidate.defaultQuality)
      ? candidate.defaultQuality
      : DEFAULT_APP_SETTINGS.defaultQuality;
  return {
    defaultVncPort,
    defaultScaleMode,
    defaultQuality,
    defaultAutoQuality: candidate.defaultAutoQuality !== false,
    defaultCaptureKeys: candidate.defaultCaptureKeys === true,
    tailscaleHostname:
      typeof candidate.tailscaleHostname === "string"
        ? candidate.tailscaleHostname.trim().slice(0, 63)
        : "",
  };
}

export function loadAppSettings(): AppSettings {
  if (typeof window === "undefined") {
    return { ...DEFAULT_APP_SETTINGS };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { ...DEFAULT_APP_SETTINGS };
    }
    return sanitizeAppSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

export function persistAppSettings(settings: AppSettings): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeAppSettings(settings)));
}

/**
 * The base view prefs for a machine with no saved prefs: the app defaults
 * layered over the built-in defaults, so new settings keys fall back
 * gracefully.
 */
export function defaultViewPrefsFromSettings(settings: AppSettings): MachineViewPrefs {
  return {
    ...DEFAULT_MACHINE_VIEW_PREFS,
    scaleMode: settings.defaultScaleMode,
    quality: settings.defaultQuality,
    autoQuality: settings.defaultAutoQuality,
    captureKeys: settings.defaultCaptureKeys,
  };
}
