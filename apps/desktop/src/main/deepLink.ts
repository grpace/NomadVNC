/**
 * OS deep-link handling for magic-link sign-in.
 *
 * The backend emails `nomadvnc://auth/callback?token=...` links. This module
 * registers the scheme with the OS and routes incoming URLs — macOS
 * `open-url`, Windows/Linux second-instance argv, and cold-start argv — to a
 * single handler. Token parsing is strict: a wrong scheme, wrong path, or
 * missing token is rejected so a stray URL can never sign anyone in.
 */

/** Custom protocol scheme the desktop app registers for magic-link sign-in. */
export const AUTH_CALLBACK_SCHEME = "nomadvnc";

export interface DeepLinkApp {
  setAsDefaultProtocolClient(protocol: string, path?: string, args?: readonly string[]): boolean;
  on(event: "open-url", listener: (event: { preventDefault(): void }, url: string) => void): unknown;
  on(event: "second-instance", listener: (event: unknown, argv: string[], workingDirectory: string) => void): unknown;
}

export interface ProtocolRegistration {
  execPath: string;
  mainEntry: string;
  /** True when running via the electron binary directly (dev), not packaged. */
  isDefaultApp: boolean;
}

/**
 * Extracts the magic token from a `nomadvnc://auth/callback?token=...`
 * URL. Accepts the `://`, `:///`, and `:` spellings of the scheme; rejects
 * anything with the wrong scheme, wrong path, or no token.
 */
export function extractAuthCallbackToken(rawUrl: string): string | null {
  const trimmed = rawUrl.trim();
  if (!trimmed.toLowerCase().startsWith(`${AUTH_CALLBACK_SCHEME}:`)) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol.toLowerCase() !== `${AUTH_CALLBACK_SCHEME}:`) {
    return null;
  }
  // The path is host + pathname with slashes trimmed, so all three
  // spellings above collapse to "auth/callback".
  const path = `${url.host}${url.pathname}`.replace(/^\/+|\/+$/g, "").toLowerCase();
  if (path !== "auth/callback") {
    return null;
  }
  const token = url.searchParams.get("token")?.trim() ?? "";
  return token !== "" ? token : null;
}

/** Finds the first auth-callback URL in a command line (cold start or second-instance argv). */
export function findAuthCallbackUrl(argv: readonly string[]): string | null {
  const prefix = `${AUTH_CALLBACK_SCHEME}:`;
  for (const arg of argv) {
    const trimmed = arg.trim();
    if (trimmed.toLowerCase().startsWith(prefix)) {
      return trimmed;
    }
  }
  return null;
}

/**
 * Registers the scheme with the OS. In dev (`electron ./dist-electron/...`)
 * the registration must point back at the electron binary plus the main
 * entry; packaged builds register the app bundle itself.
 */
export function registerAuthCallbackProtocol(app: DeepLinkApp, registration: ProtocolRegistration): void {
  if (registration.isDefaultApp) {
    app.setAsDefaultProtocolClient(AUTH_CALLBACK_SCHEME, registration.execPath, [registration.mainEntry]);
  } else {
    app.setAsDefaultProtocolClient(AUTH_CALLBACK_SCHEME);
  }
}

/** Routes macOS open-url and Windows/Linux second-instance URLs to onUrl. */
export function watchAuthCallbackUrls(app: DeepLinkApp, onUrl: (url: string) => void): void {
  app.on("open-url", (event, url) => {
    event.preventDefault();
    onUrl(url);
  });
  app.on("second-instance", (_event, argv) => {
    const url = findAuthCallbackUrl(argv);
    if (url) {
      onUrl(url);
    }
  });
}
