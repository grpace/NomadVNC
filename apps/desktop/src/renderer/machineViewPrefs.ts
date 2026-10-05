export type MachineScaleMode = "fit" | "actual" | "zoom";
export type MachineOsTab = "Windows" | "macOS" | "Linux";
export type MachineDisplayRegion = "full" | "left" | "right" | "top" | "bottom";

export interface MachineViewPrefs {
  scaleMode: MachineScaleMode;
  zoomLevel: number;
  quality: number;
  osTab: MachineOsTab;
  /** Remember the keyboard-capture ("grab Super/Alt-Tab") toggle per machine. */
  captureKeys: boolean;
  /** Auto-degrade quality on slow tailnet paths (manual setting stays the ceiling). */
  autoQuality: boolean;
  /** Monitor-half view over a spanning multi-monitor framebuffer. */
  displayRegion: MachineDisplayRegion;
}

export const DEFAULT_MACHINE_VIEW_PREFS: MachineViewPrefs = {
  scaleMode: "fit",
  zoomLevel: 1,
  quality: 6,
  osTab: "Windows",
  captureKeys: false,
  autoQuality: true,
  displayRegion: "full",
};

export type MachineViewPrefsMap = Record<string, MachineViewPrefs>;

const STORAGE_KEY = "nomadvnc.desktop.machineViewPrefs.v1";

const VALID_SCALE_MODES: MachineScaleMode[] = ["fit", "actual", "zoom"];
const VALID_OS_TABS: MachineOsTab[] = ["Windows", "macOS", "Linux"];
const VALID_DISPLAY_REGIONS: MachineDisplayRegion[] = ["full", "left", "right", "top", "bottom"];
const VALID_QUALITIES = [2, 5, 6, 8, 9];
const VALID_ZOOMS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

function sanitizePrefs(value: unknown): MachineViewPrefs | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const candidate = value as Partial<MachineViewPrefs>;
  const scaleMode = VALID_SCALE_MODES.includes(candidate.scaleMode as MachineScaleMode)
    ? (candidate.scaleMode as MachineScaleMode)
    : DEFAULT_MACHINE_VIEW_PREFS.scaleMode;
  const zoomLevel = typeof candidate.zoomLevel === "number" && VALID_ZOOMS.includes(candidate.zoomLevel)
    ? candidate.zoomLevel
    : DEFAULT_MACHINE_VIEW_PREFS.zoomLevel;
  const quality = typeof candidate.quality === "number" && VALID_QUALITIES.includes(candidate.quality)
    ? candidate.quality
    : DEFAULT_MACHINE_VIEW_PREFS.quality;
  const osTab = VALID_OS_TABS.includes(candidate.osTab as MachineOsTab)
    ? (candidate.osTab as MachineOsTab)
    : DEFAULT_MACHINE_VIEW_PREFS.osTab;
  const captureKeys = candidate.captureKeys === true;
  const autoQuality = candidate.autoQuality !== false;
  const displayRegion = VALID_DISPLAY_REGIONS.includes(candidate.displayRegion as MachineDisplayRegion)
    ? (candidate.displayRegion as MachineDisplayRegion)
    : DEFAULT_MACHINE_VIEW_PREFS.displayRegion;
  return { scaleMode, zoomLevel, quality, osTab, captureKeys, autoQuality, displayRegion };
}

export function loadMachineViewPrefs(): MachineViewPrefsMap {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const next: MachineViewPrefsMap = {};
    for (const [machineId, prefs] of Object.entries(parsed as Record<string, unknown>)) {
      const sanitized = sanitizePrefs(prefs);
      if (sanitized) {
        next[machineId] = sanitized;
      }
    }
    return next;
  } catch {
    return {};
  }
}

export function persistMachineViewPrefs(prefs: MachineViewPrefsMap): void {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
}

export function getMachineViewPrefs(
  all: MachineViewPrefsMap,
  machineId: string | undefined,
  base: MachineViewPrefs = DEFAULT_MACHINE_VIEW_PREFS,
): MachineViewPrefs {
  if (!machineId) {
    return { ...base };
  }
  return { ...base, ...(all[machineId] ?? {}) };
}

export function setMachineViewPrefs(
  all: MachineViewPrefsMap,
  machineId: string,
  partial: Partial<MachineViewPrefs>,
): MachineViewPrefsMap {
  const current = all[machineId] ?? DEFAULT_MACHINE_VIEW_PREFS;
  const merged = sanitizePrefs({ ...current, ...partial }) ?? { ...DEFAULT_MACHINE_VIEW_PREFS };
  return { ...all, [machineId]: merged };
}
