import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { UpdatePrefs, UpdateStatus } from "@nomadvnc/platform-contracts";
// electron-updater is CommonJS; the main bundle is ESM, so named imports
// fail at runtime. Default-import and destructure instead.
import electronUpdaterPkg from "electron-updater";
import type { UpdateInfo } from "electron-updater";

/**
 * Lazily resolves electron-updater's autoUpdater. Accessing the property
 * constructs the real updater, which requires the Electron app runtime, so
 * this must never run at module load (unit tests) or outside the main
 * process.
 */
function loadDefaultAutoUpdater(): AutoUpdaterLike {
  const pkg = electronUpdaterPkg as unknown as { autoUpdater: AutoUpdaterLike };
  return pkg.autoUpdater;
}

/** Stand-in used when the real updater can't load (dev, unpackaged builds). */
const NOOP_UPDATER: AutoUpdaterLike = {
  autoDownload: false,
  checkForUpdates: () => Promise.resolve(null),
  downloadUpdate: () => Promise.resolve(undefined),
  quitAndInstall: () => {},
  on: () => undefined,
};

/**
 * App self-update via electron-updater (GitHub releases feed, configured in
 * package.json `build.publish`). The sidecar binary ships inside the app
 * bundle as an extraResource, so it updates with the app — no separate
 * sidecar update path is needed.
 *
 * Flow: check → update-available → auto-download in background →
 * update-downloaded ("ready") → user restarts → quitAndInstall().
 * On Linux deb/rpm installs the package-manager install may need
 * privileges; a failed install surfaces as an error status with guidance
 * instead of failing silently.
 */

export const DEFAULT_UPDATE_PREFS: UpdatePrefs = {
  enabled: true,
  autoCheck: true,
};

/** Minimal surface of electron-updater's autoUpdater we rely on. */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  checkForUpdates(): Promise<{ updateInfo: UpdateInfo } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface UpdateManagerDeps {
  /** app.isPackaged — updates only make sense in packaged builds. */
  isPackaged: boolean;
  /** app.getPath("userData") — where update.json lives. */
  userDataDir: string;
  currentVersion: string;
  onStatus: (status: UpdateStatus) => void;
  log?: (message: string, detail?: unknown) => void;
  autoUpdater?: AutoUpdaterLike;
  /** Defaults to `process.platform`; injectable for tests. */
  platform?: NodeJS.Platform;
  /** Where users can download a release by hand. */
  releasesUrl?: string;
}

export const DEFAULT_RELEASES_URL = "https://github.com/grpace/NomadVNC/releases/latest";

/**
 * macOS (Squirrel.Mac) only installs updates into a code-signed app; an
 * unsigned build downloads fine and then fails with a signature error.
 */
export function isUnsignedMacInstallError(platform: NodeJS.Platform, message: string): boolean {
  return platform === "darwin" && /code ?sign|signature|not signed/i.test(message);
}

const PREFS_FILE = "update.json";
const STARTUP_CHECK_DELAY_MS = 45_000;
const AUTO_CHECK_INTERVAL_MS = 6 * 60 * 60_000;

function sanitizePrefs(value: unknown): UpdatePrefs {
  if (!value || typeof value !== "object") {
    return { ...DEFAULT_UPDATE_PREFS };
  }
  const candidate = value as Partial<UpdatePrefs>;
  return {
    enabled: candidate.enabled !== false,
    autoCheck: candidate.autoCheck !== false,
  };
}

export class UpdateManager {
  private readonly updater: AutoUpdaterLike;
  private readonly userDataDir: string;
  private readonly isPackaged: boolean;
  private readonly currentVersion: string;
  private readonly onStatus: (status: UpdateStatus) => void;
  private readonly log: (message: string, detail?: unknown) => void;
  private status: UpdateStatus = { state: "idle" };
  private prefs: UpdatePrefs = { ...DEFAULT_UPDATE_PREFS };
  private checkTimer: NodeJS.Timeout | undefined;
  private checkInFlight = false;
  private readonly platform: NodeJS.Platform;
  private readonly releasesUrl: string;

  constructor(deps: UpdateManagerDeps) {
    this.log = deps.log ?? (() => {});
    this.updater = deps.autoUpdater ?? this.resolveUpdater(deps);
    this.userDataDir = deps.userDataDir;
    this.isPackaged = deps.isPackaged;
    this.currentVersion = deps.currentVersion;
    this.onStatus = deps.onStatus;
    this.platform = deps.platform ?? process.platform;
    this.releasesUrl = deps.releasesUrl ?? DEFAULT_RELEASES_URL;
    this.updater.autoDownload = false;

    this.updater.on("update-available", (info) => {
      const updateInfo = info as UpdateInfo;
      this.log("update available", updateInfo.version);
      this.setStatus({ state: "available", version: updateInfo.version });
      // Download in the background so "restart to install" is one click.
      void this.downloadUpdate().catch(() => {
        // downloadUpdate already reports failures via status.
      });
    });
    this.updater.on("update-not-available", (info) => {
      const updateInfo = info as UpdateInfo | undefined;
      this.log("no update available", updateInfo?.version);
      this.setStatus({
        state: "not-available",
        message: `You're on the latest version (${this.currentVersion}).`,
        lastChecked: new Date().toISOString(),
      });
    });
    this.updater.on("download-progress", (progress) => {
      const percent = Math.round((progress as { percent?: number }).percent ?? 0);
      this.setStatus({
        state: "downloading",
        version: this.status.version,
        percent,
      });
    });
    this.updater.on("update-downloaded", (info) => {
      const updateInfo = info as UpdateInfo;
      this.log("update downloaded", updateInfo.version);
      this.setStatus({ state: "ready", version: updateInfo.version });
    });
    this.updater.on("error", (error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.log("updater error", message);
      if (isUnsignedMacInstallError(this.platform, message)) {
        this.setStatus(this.manualInstallStatus());
        return;
      }
      // A failed download returns to available so the user can retry.
      if (this.status.state === "downloading" || this.status.state === "available") {
        this.setStatus({
          state: "available",
          version: this.status.version,
          message: `Download failed: ${message}`,
        });
        return;
      }
      this.setStatus({ state: "error", message });
    });
  }

  getStatus(): UpdateStatus {
    return { ...this.status };
  }

  getPrefs(): UpdatePrefs {
    return { ...this.prefs };
  }

  getCurrentVersion(): string {
    return this.currentVersion;
  }

  async init(): Promise<void> {
    this.prefs = await this.loadPrefs();
  }

  async setPrefs(prefs: UpdatePrefs): Promise<UpdatePrefs> {
    this.prefs = sanitizePrefs(prefs);
    await this.savePrefs();
    if (!this.prefs.enabled || !this.prefs.autoCheck) {
      this.stopScheduler();
    } else {
      this.startScheduler();
    }
    return this.getPrefs();
  }

  /** Begin the delayed startup check + periodic interval. No-op in dev. */
  startScheduler(): void {
    this.stopScheduler();
    if (!this.isPackaged || !this.prefs.enabled || !this.prefs.autoCheck) {
      return;
    }
    this.checkTimer = setTimeout(() => {
      void this.checkForUpdates(false);
      this.checkTimer = setInterval(() => {
        void this.checkForUpdates(false);
      }, AUTO_CHECK_INTERVAL_MS);
      // Allow the process to exit even if the timer is pending.
      this.checkTimer.unref?.();
    }, STARTUP_CHECK_DELAY_MS);
    this.checkTimer.unref?.();
  }

  stopScheduler(): void {
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
      clearInterval(this.checkTimer);
      this.checkTimer = undefined;
    }
  }

  async checkForUpdates(manual: boolean): Promise<UpdateStatus> {
    if (!this.isPackaged) {
      const status: UpdateStatus = {
        state: "error",
        message: "Updates are only available in packaged builds.",
      };
      this.setStatus(status);
      return this.getStatus();
    }
    if (!this.prefs.enabled) {
      const status: UpdateStatus = {
        state: "error",
        message: "Automatic updates are disabled in Settings → Updates.",
      };
      this.setStatus(status);
      return this.getStatus();
    }
    if (this.checkInFlight) {
      return this.getStatus();
    }
    this.checkInFlight = true;
    this.setStatus({ state: "checking" });
    try {
      await this.updater.checkForUpdates();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log("check failed", message);
      // Stay quiet on plain connectivity loss during background checks;
      // a manual check deserves the honest error.
      if (manual) {
        this.setStatus({ state: "error", message });
      } else {
        this.setStatus({ state: "idle" });
      }
    } finally {
      this.checkInFlight = false;
    }
    return this.getStatus();
  }

  async downloadUpdate(): Promise<UpdateStatus> {
    if (this.status.state !== "available") {
      return this.getStatus();
    }
    this.setStatus({ state: "downloading", version: this.status.version, percent: 0 });
    try {
      await this.updater.downloadUpdate();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log("download failed", message);
      this.setStatus({
        state: "available",
        version: this.status.version,
        message: `Download failed: ${message}`,
      });
    }
    return this.getStatus();
  }

  quitAndInstall(): void {
    if (this.status.state !== "ready") {
      return;
    }
    try {
      this.updater.quitAndInstall(false, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log("quitAndInstall failed", message);
      if (isUnsignedMacInstallError(this.platform, message)) {
        this.setStatus(this.manualInstallStatus());
        return;
      }
      this.setStatus({
        state: "error",
        message:
          `Couldn't install the update automatically (${message}). ` +
          "Package installs (.deb/.rpm) can need administrator privileges. " +
          "Update with your package manager, or download the new version.",
        manualDownloadUrl: this.releasesUrl,
      });
    }
  }

  /** The update exists but this install can't apply it itself: send the user to the download. */
  private manualInstallStatus(): UpdateStatus {
    return {
      state: "error",
      version: this.status.version,
      message:
        "A new version is available, but this build isn't code-signed, so macOS " +
        "can't install it automatically. Download it and replace the app.",
      manualDownloadUrl: this.releasesUrl,
    };
  }

  private setStatus(status: UpdateStatus): void {
    this.status = status;
    this.onStatus({ ...status });
  }

  /**
   * The real updater only exists in packaged builds: in dev `app.getVersion()`
   * isn't valid semver and electron-updater's constructor throws. A failure
   * here must never break app startup, so fall back to a no-op updater.
   */
  private resolveUpdater(deps: UpdateManagerDeps): AutoUpdaterLike {
    if (!deps.isPackaged) {
      return NOOP_UPDATER;
    }
    try {
      return loadDefaultAutoUpdater();
    } catch (error) {
      this.log(
        "real updater unavailable, updates disabled",
        error instanceof Error ? error.message : error,
      );
      return NOOP_UPDATER;
    }
  }

  private prefsPath(): string {
    return join(this.userDataDir, PREFS_FILE);
  }

  private async loadPrefs(): Promise<UpdatePrefs> {
    try {
      const raw = await fs.readFile(this.prefsPath(), "utf8");
      return sanitizePrefs(JSON.parse(raw));
    } catch {
      return { ...DEFAULT_UPDATE_PREFS };
    }
  }

  private async savePrefs(): Promise<void> {
    try {
      await fs.mkdir(this.userDataDir, { recursive: true });
      await fs.writeFile(this.prefsPath(), JSON.stringify(this.prefs, null, 2), "utf8");
    } catch (error) {
      this.log("failed to save update prefs", error instanceof Error ? error.message : error);
    }
  }
}
