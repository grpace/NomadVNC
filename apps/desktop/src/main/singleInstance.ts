/**
 * Single-instance enforcement for the desktop main process.
 *
 * A second app launch would spawn a second Go sidecar over the same tsnet
 * state directory, risking identity/state corruption. Instead the second
 * process quits immediately and the primary instance brings its window
 * forward.
 */

export interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(event: "second-instance", listener: () => void): void;
}

export interface SingleInstanceWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  focus(): void;
}

/**
 * Requests the Electron single-instance lock.
 *
 * @returns true when this process owns the lock and should continue startup;
 *          false when another instance is already running (we already asked
 *          Electron to quit, so the caller must skip startup work).
 */
export function enforceSingleInstance(
  electronApp: SingleInstanceApp,
  getWindow: () => SingleInstanceWindow | null,
): boolean {
  if (!electronApp.requestSingleInstanceLock()) {
    electronApp.quit();
    return false;
  }
  electronApp.on("second-instance", () => {
    const window = getWindow();
    if (!window || window.isDestroyed()) {
      return;
    }
    if (window.isMinimized()) {
      window.restore();
    }
    window.focus();
  });
  return true;
}
