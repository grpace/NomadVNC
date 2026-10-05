import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MACHINE_VIEW_PREFS,
  getMachineViewPrefs,
  loadMachineViewPrefs,
  persistMachineViewPrefs,
  setMachineViewPrefs,
} from "./machineViewPrefs";

describe("machineViewPrefs", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("returns defaults for unknown machines", () => {
    expect(getMachineViewPrefs({}, "missing")).toEqual(DEFAULT_MACHINE_VIEW_PREFS);
    expect(getMachineViewPrefs({}, undefined)).toEqual(DEFAULT_MACHINE_VIEW_PREFS);
  });

  it("persists and reloads per-machine prefs", () => {
    const next = setMachineViewPrefs({}, "machine-1", { scaleMode: "zoom", zoomLevel: 1.5, quality: 8, osTab: "Linux", captureKeys: true, autoQuality: false, displayRegion: "left" });
    persistMachineViewPrefs(next);

    expect(loadMachineViewPrefs()["machine-1"]).toEqual({
      scaleMode: "zoom",
      zoomLevel: 1.5,
      quality: 8,
      osTab: "Linux",
      captureKeys: true,
      autoQuality: false,
      displayRegion: "left",
    });
  });

  it("merges partial updates without touching other machines", () => {
    const seeded = setMachineViewPrefs({}, "machine-1", { quality: 8 });
    const next = setMachineViewPrefs(seeded, "machine-2", { osTab: "macOS" });

    expect(next["machine-1"]?.quality).toBe(8);
    expect(next["machine-2"]).toEqual({ ...DEFAULT_MACHINE_VIEW_PREFS, osTab: "macOS" });
  });

  it("sanitizes invalid stored values back to defaults", () => {
    window.localStorage.setItem(
      "nomadvnc.desktop.machineViewPrefs.v1",
      JSON.stringify({
        "machine-1": { scaleMode: "spin", zoomLevel: 99, quality: 42, osTab: "Amiga", captureKeys: "yes" },
      }),
    );

    expect(loadMachineViewPrefs()["machine-1"]).toEqual(DEFAULT_MACHINE_VIEW_PREFS);
  });

  it("defaults captureKeys to false for prefs stored before the field existed", () => {
    window.localStorage.setItem(
      "nomadvnc.desktop.machineViewPrefs.v1",
      JSON.stringify({
        "machine-1": { scaleMode: "fit", zoomLevel: 1, quality: 6, osTab: "Windows" },
      }),
    );

    expect(loadMachineViewPrefs()["machine-1"]?.captureKeys).toBe(false);
  });

  it("defaults autoQuality to true unless explicitly disabled", () => {
    window.localStorage.setItem(
      "nomadvnc.desktop.machineViewPrefs.v1",
      JSON.stringify({
        "machine-1": { scaleMode: "fit", zoomLevel: 1, quality: 6, osTab: "Windows" },
        "machine-2": { scaleMode: "fit", zoomLevel: 1, quality: 6, osTab: "Windows", autoQuality: false },
      }),
    );

    expect(loadMachineViewPrefs()["machine-1"]?.autoQuality).toBe(true);
    expect(loadMachineViewPrefs()["machine-2"]?.autoQuality).toBe(false);
  });
});
