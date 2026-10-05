// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "@nomadvnc/platform-contracts";
import { UpdateManager, type AutoUpdaterLike } from "./updater";

function createFakeUpdater(): AutoUpdaterLike & {
  emit: (event: string, ...args: unknown[]) => void;
  checkForUpdatesImpl: { current: () => Promise<unknown> };
  downloadUpdateImpl: { current: () => Promise<unknown> };
  quitAndInstall: ReturnType<typeof vi.fn>;
} {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const fake = {
    autoDownload: true,
    checkForUpdatesImpl: { current: () => Promise.resolve(null) },
    downloadUpdateImpl: { current: () => Promise.resolve(undefined) },
    checkForUpdates: vi.fn(() => fake.checkForUpdatesImpl.current()),
    downloadUpdate: () => fake.downloadUpdateImpl.current(),
    quitAndInstall: vi.fn(),
    on: (event: string, listener: (...args: unknown[]) => void) => {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
      return fake;
    },
    emit: (event: string, ...args: unknown[]) => {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args);
      }
    },
  };
  return fake;
}

function createManager(
  fake: AutoUpdaterLike,
  overrides?: { isPackaged?: boolean; userDataDir?: string },
): { manager: UpdateManager; statuses: UpdateStatus[] } {
  const statuses: UpdateStatus[] = [];
  const manager = new UpdateManager({
    isPackaged: overrides?.isPackaged ?? true,
    userDataDir: overrides?.userDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "nomadvnc-update-test-")),
    currentVersion: "0.1.0",
    onStatus: (status) => statuses.push(status),
    autoUpdater: fake,
  });
  return { manager, statuses };
}

describe("UpdateManager", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("refuses checks in unpackaged builds with an honest status", async () => {
    const fake = createFakeUpdater();
    const { manager, statuses } = createManager(fake, { isPackaged: false });
    await manager.init();
    const status = await manager.checkForUpdates(true);
    expect(status.state).toBe("error");
    expect(status.message).toContain("packaged builds");
    expect(fake.checkForUpdates).not.toHaveBeenCalled();
    expect(statuses.at(-1)?.state).toBe("error");
  });

  it("runs the full available → downloading → ready flow", async () => {
    const fake = createFakeUpdater();
    const { manager, statuses } = createManager(fake);
    await manager.init();

    const check = manager.checkForUpdates(true);
    fake.emit("update-available", { version: "0.2.0" });
    await check;

    expect(statuses.map((s) => s.state)).toContain("available");
    // The manager auto-downloads after update-available.
    fake.emit("download-progress", { percent: 42 });
    expect(manager.getStatus()).toMatchObject({ state: "downloading", percent: 42, version: "0.2.0" });
    fake.emit("update-downloaded", { version: "0.2.0" });
    expect(manager.getStatus()).toMatchObject({ state: "ready", version: "0.2.0" });
  });

  it("reports not-available with a last-checked timestamp", async () => {
    const fake = createFakeUpdater();
    const { manager } = createManager(fake);
    await manager.init();

    const check = manager.checkForUpdates(true);
    fake.emit("update-not-available", { version: "0.1.0" });
    await check;

    const status = manager.getStatus();
    expect(status.state).toBe("not-available");
    expect(status.lastChecked).toBeTruthy();
    expect(status.message).toContain("0.1.0");
  });

  it("stays quiet on background check failures but honest on manual ones", async () => {
    const fake = createFakeUpdater();
    fake.checkForUpdatesImpl.current = () => Promise.reject(new Error("net down"));
    const { manager } = createManager(fake);
    await manager.init();

    expect((await manager.checkForUpdates(false)).state).toBe("idle");
    const manual = await manager.checkForUpdates(true);
    expect(manual.state).toBe("error");
    expect(manual.message).toContain("net down");
  });

  it("returns to available with a message when the download fails", async () => {
    const fake = createFakeUpdater();
    fake.downloadUpdateImpl.current = () => Promise.reject(new Error("socket hangup"));
    const { manager } = createManager(fake);
    await manager.init();

    const check = manager.checkForUpdates(true);
    fake.emit("update-available", { version: "0.2.0" });
    await check;
    // Allow the auto-download promise to settle.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const status = manager.getStatus();
    expect(status.state).toBe("available");
    expect(status.message).toContain("socket hangup");
  });

  it("only quits-and-installs when an update is ready", () => {
    const fake = createFakeUpdater();
    const { manager } = createManager(fake);

    manager.quitAndInstall();
    expect(fake.quitAndInstall).not.toHaveBeenCalled();

    fake.emit("update-downloaded", { version: "0.2.0" });
    manager.quitAndInstall();
    expect(fake.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("surfaces install failures as an error status with guidance", () => {
    const fake = createFakeUpdater();
    fake.quitAndInstall.mockImplementation(() => {
      throw new Error("permission denied");
    });
    const { manager } = createManager(fake);

    fake.emit("update-downloaded", { version: "0.2.0" });
    manager.quitAndInstall();

    const status = manager.getStatus();
    expect(status.state).toBe("error");
    expect(status.message).toContain("package manager");
  });

  it("persists prefs and blocks checks when disabled", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomadvnc-update-prefs-"));
    const fake = createFakeUpdater();
    const { manager } = createManager(fake, { userDataDir: dir });
    await manager.init();

    await manager.setPrefs({ enabled: false, autoCheck: false });
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "update.json"), "utf8"));
    expect(raw).toEqual({ enabled: false, autoCheck: false });

    const status = await manager.checkForUpdates(true);
    expect(status.state).toBe("error");
    expect(status.message).toContain("disabled");

    // A fresh manager in the same dir picks up the saved prefs.
    const { manager: reloaded } = createManager(createFakeUpdater(), { userDataDir: dir });
    await reloaded.init();
    expect(reloaded.getPrefs()).toEqual({ enabled: false, autoCheck: false });
  });

  it("disables autoDownload on the underlying updater", () => {
    const fake = createFakeUpdater();
    createManager(fake);
    expect(fake.autoDownload).toBe(false);
  });

  it("never loads the real updater in unpackaged builds (dev semver is invalid)", async () => {
    // Regression test: in dev app.getVersion() is "0.0" and electron-updater's
    // constructor throws on invalid semver. Constructing without an injected
    // updater must not throw and must report updates as unavailable.
    const statuses: UpdateStatus[] = [];
    const manager = new UpdateManager({
      isPackaged: false,
      userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "nomadvnc-update-dev-")),
      currentVersion: "0.0",
      onStatus: (status) => statuses.push(status),
    });
    await manager.init();
    const status = await manager.checkForUpdates(true);
    expect(status.state).toBe("error");
    expect(status.message).toContain("packaged builds");
  });
});

describe("UpdateManager on unsigned macOS builds", () => {
  it("turns Squirrel's signature failure into a plain download link", async () => {
    const fake = createFakeUpdater();
    const statuses: UpdateStatus[] = [];
    const manager = new UpdateManager({
      isPackaged: true,
      userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "nomadvnc-update-test-")),
      currentVersion: "0.1.0",
      onStatus: (status) => statuses.push(status),
      autoUpdater: fake,
      platform: "darwin",
      releasesUrl: "https://example.test/releases/latest",
    });
    await manager.init();
    fake.emit("update-available", { version: "0.2.0" });
    fake.emit("error", new Error("Could not get code signature for running application"));

    const last = statuses[statuses.length - 1];
    expect(last).toMatchObject({
      state: "error",
      version: "0.2.0",
      manualDownloadUrl: "https://example.test/releases/latest",
    });
    expect(last?.message).toContain("isn't code-signed");
  });

  it("leaves the same error alone on other platforms", async () => {
    const { isUnsignedMacInstallError } = await import("./updater");
    expect(isUnsignedMacInstallError("linux", "code signature")).toBe(false);
    expect(isUnsignedMacInstallError("darwin", "network timeout")).toBe(false);
  });
});
