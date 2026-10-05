import { createViewerHtml, type PointerMode } from "@nomadvnc/viewer-shell";

export interface MobileViewerConfig {
  wsUrl: string;
  password: string;
  username?: string;
  /**
   * Base URL of the native module's loopback viewer-asset server
   * (e.g. `http://127.0.0.1:PORT`). Serves `viewer-runtime.js` and
   * `viewer-bootstrap.mjs` with permissive CORS so the WebView can load
   * the bootstrap as a module script — already allowed by the shared
   * viewer CSP (`script-src` includes `http://127.0.0.1:*`), so no custom
   * URL scheme or WebView surgery is needed.
   */
  assetBaseUrl: string;
  /** Initial touch pointer mode; switchable live via `setPointerMode`. */
  pointerMode?: PointerMode;
}

/**
 * Builds the WebView HTML for a mobile session. Pure function of its
 * inputs so the URL wiring is unit-testable without a device.
 */
export function buildMobileViewerHtml(config: MobileViewerConfig): string {
  const base = config.assetBaseUrl.replace(/\/+$/, "");
  return createViewerHtml({
    wsUrl: config.wsUrl,
    password: config.password,
    username: config.username,
    bootstrapModuleUrl: `${base}/viewer-runtime.js`,
    bootstrapScriptUrl: `${base}/viewer-bootstrap.mjs`,
    inputModuleUrl: `${base}/viewer-input.mjs`,
    pointerMode: config.pointerMode ?? "touch",
    desktop: false,
    fitToScreen: true,
  });
}
