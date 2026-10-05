/**
 * Electron renderer Content-Security-Policy.
 *
 * Two variants:
 * - production: renderer loads from `file://` (packaged build). Scripts,
 *   styles, and fonts are all bundled locally; the only network endpoints
 *   allowed are loopback WebSocket/HTTP endpoints owned by the Go sidecar
 *   proxy. No remote CDN origins.
 * - development: renderer loads from the Vite dev server on loopback
 *   (`http://127.0.0.1:5173`), which needs `unsafe-inline`/`unsafe-eval` for
 *   HMR plus explicit dev-server origins.
 *
 * The noVNC iframe itself carries its own stricter policy, see
 * `VIEWER_IFRAME_CSP` in `@nomadvnc/viewer-shell`.
 */

const DEV_SERVER_HTTP = ["http://127.0.0.1:5173", "http://localhost:5173"].join(" ");
const LOOPBACK_HTTP =
  ["http://127.0.0.1:*", "http://localhost:*"].join(" ");
const LOOPBACK_WS = [
  "ws://127.0.0.1:*",
  "ws://localhost:*",
  "wss://127.0.0.1:*",
  "wss://localhost:*",
].join(" ");

export const PRODUCTION_RENDERER_CSP = [
  "default-src 'self' file: data:",
  "script-src 'self' file:",
  "style-src 'self' file: 'unsafe-inline'",
  "font-src 'self' file: data:",
  "img-src 'self' file: data: blob:",
  `connect-src 'self' ${LOOPBACK_WS} ${LOOPBACK_HTTP}`,
  "media-src 'self' file: data: blob:",
  "worker-src 'self' file: blob:",
  "frame-src 'self' blob:",
  "child-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self' file:",
  "form-action 'none'",
  "frame-ancestors 'self' file:",
].join("; ");

export const DEVELOPMENT_RENDERER_CSP = [
  "default-src 'self' data: blob:",
  `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${DEV_SERVER_HTTP}`,
  `style-src 'self' 'unsafe-inline' ${DEV_SERVER_HTTP}`,
  `font-src 'self' data: ${DEV_SERVER_HTTP}`,
  `img-src 'self' data: blob: ${DEV_SERVER_HTTP}`,
  `connect-src 'self' ${LOOPBACK_WS} ${LOOPBACK_HTTP}`,
  "media-src 'self' data: blob:",
  "worker-src 'self' blob:",
  "frame-src 'self' blob:",
  "child-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
  `frame-ancestors 'self' ${DEV_SERVER_HTTP}`,
].join("; ");

/** `isPackaged` mirrors `app.isPackaged`: packaged builds get the strict policy. */
export function getRendererCsp(isPackaged: boolean): string {
  return isPackaged ? PRODUCTION_RENDERER_CSP : DEVELOPMENT_RENDERER_CSP;
}

/**
 * CSP variant for `<meta http-equiv>` delivery (baked into `index.html` by the
 * Vite build). `frame-ancestors` is ignored in meta-delivered policies — and
 * Chromium logs a console warning for it — so it is stripped here. It stays
 * enforced through the `Content-Security-Policy` response header set in
 * `main.ts`, which keeps the full policy.
 */
export function getMetaCsp(isPackaged: boolean): string {
  return getRendererCsp(isPackaged)
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d.length > 0 && !d.startsWith("frame-ancestors"))
    .join("; ");
}
