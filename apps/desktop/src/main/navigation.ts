/**
 * URL policy for the main window. The renderer holds the privileged
 * preload bridge, so it may only ever show the app's own entry document;
 * every other link goes to the system browser, and only when it is a
 * plain web URL.
 */

/** http(s) only: never hand file:, smb:, or arbitrary custom schemes to the OS. */
export function isSafeExternalUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * True when `raw` points at the renderer entry itself (reloads, hash/query
 * changes, the Vite dev server). Anything else is a navigation away.
 */
export function isAppNavigation(raw: string, entryUrl: string): boolean {
  try {
    const target = new URL(raw);
    const entry = new URL(entryUrl);
    if (target.protocol !== entry.protocol) {
      return false;
    }
    if (entry.protocol === "file:") {
      return target.pathname === entry.pathname;
    }
    return target.origin === entry.origin;
  } catch {
    return false;
  }
}
