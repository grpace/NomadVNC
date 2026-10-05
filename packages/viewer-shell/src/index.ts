export type PointerMode = "touch" | "trackpad";

export interface ViewerShellConfig {
  wsUrl: string;
  password?: string;
  /** macOS Screen Sharing often uses ARD auth and requires the account short name with the password. */
  username?: string;
  /**
   * URL of the bundled noVNC RFB module (desktop: vendored `rfb.js`;
   * mobile: the native asset server's `viewer-runtime.js`). Always local —
   * there is deliberately no remote CDN fallback.
   */
  bootstrapModuleUrl: string;
  /**
   * Absolute URL of the external viewer bootstrap module (`bootstrap.mjs`).
   * The bootstrap is intentionally NOT inlined: the Electron renderer's CSP
   * omits `'unsafe-inline'` and also applies to `srcdoc` iframes, so an
   * inline bootstrap would be refused and the viewer would stall forever.
   */
  bootstrapScriptUrl: string;
  /**
   * URL of the touch/text input module (`input.mjs`). Optional: without it
   * the viewer falls back to noVNC's built-in touch handling and can't
   * type text sent by the app.
   */
  inputModuleUrl?: string;
  /** Initial touch pointer mode (see `input.mjs`). Default "touch". */
  pointerMode?: PointerMode;
  desktop: boolean;
  fitToScreen?: boolean;
  resizeSession?: boolean;
  preferredWidth?: number;
  preferredHeight?: number;
}

/**
 * Commands that the parent window can send to the viewer iframe via postMessage.
 *
 * - `sendKeys`: Sends one or more keysyms (press+release) to the remote server.
 * - `sendKeyCombo`: Holds modifier keys then presses the final key.
 * - `setKeyStates`: Sets explicit press/release state for specific key(s), allowing "sticky" modifiers.
 * - `setResizeSession`: Toggles whether the remote desktop should resize to match the viewer window.
 * - `setResolution`: Requests the remote desktop change to a specific resolution.
 * - `setScaleMode`: Switches between fit-to-window, 1:1, and custom zoom levels.
 *   Zoomed views larger than the window pan (touch drag, or the mouse at
 *   the window edge).
 * - `setQuality`: Adjusts JPEG compression quality (0–9).
 * - `clipboardPaste`: Injects text into the remote clipboard and types it.
 * - `clipboardRequest`: Asks the viewer to send back the current remote clipboard content.
 * - `focus`: Gives keyboard focus to the RFB canvas.
 * - `typeText`: Types text as key presses (soft keyboards, "paste as typing").
 * - `setPointerMode`: Touch gestures as direct touch or as a trackpad.
 * - `resetView`: Undoes pinch-zoom and panning.
 * - `queryConnection`: Asks whether the RFB socket is still open. The
 *   viewer answers with `viewerAlive`. `refresh` requests a full
 *   framebuffer so a session that was suspended comes back up to date.
 */
export type ViewerCommand =
  | { type: "sendKeys"; keysyms: number[] }
  | { type: "sendKeyCombo"; modifiers: number[]; key: number }
  | { type: "setKeyStates"; keys: Array<{ keysym: number; down: boolean }> }
  | { type: "setResizeSession"; enabled: boolean }
  | { type: "setResolution"; width: number; height: number }
  | { type: "setScaleMode"; mode: "fit" | "actual" | "zoom"; zoomLevel?: number }
  | { type: "setDisplayRegion"; region: "full" | "left" | "right" | "top" | "bottom" }
  | { type: "setQuality"; quality: number }
  | { type: "clipboardPaste"; text: string }
  | { type: "clipboardRequest" }
  | { type: "focus" }
  | { type: "sendCredentials"; username?: string; password?: string }
  | { type: "typeText"; text: string }
  | { type: "setPointerMode"; mode: PointerMode }
  | { type: "resetView" }
  | { type: "queryConnection"; refresh?: boolean };

/**
 * Events that the viewer iframe sends back to the parent via postMessage.
 *
 * - `viewerActive` is throttled (at most one per 2s of input) and `viewerIdle`
 *   fires 1.5s after the last pointer/keyboard input, so the parent can run
 *   adaptive quality: lossy while interacting, sharp refresh once idle.
 */
export type ViewerEvent =
  | { type: "viewerReady" }
  | { type: "viewerState"; state: "connected" | "disconnected" | "credentialsRequired" }
  /**
   * The server rejected the credentials (RFB security failure, e.g. a wrong
   * VNC password). Terminal for this connection: retrying with the same
   * password is pointless, and many servers blacklist repeat failures. No
   * `disconnected` event follows it.
   */
  | { type: "viewerState"; state: "authFailed"; reason?: string }
  | { type: "viewerClipboard"; text: string }
  | { type: "viewerResize"; width: number; height: number }
  | { type: "viewerActive" }
  | { type: "viewerIdle" }
  /**
   * The local view's zoom relative to the selected scale mode (1 = not
   * pinch-zoomed), so the app can offer to reset it.
   */
  | { type: "viewerZoom"; level: number }
  /** A touch long-press registered (the app may give haptic feedback). */
  | { type: "viewerLongPress" }
  /**
   * Reply to `queryConnection`. `live` means the RFB socket is still open,
   * so the app should keep the session instead of reconnecting.
   */
  | { type: "viewerAlive"; live: boolean };

function escapeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/**
 * Content-Security-Policy for the noVNC iframe document produced by
 * {@link createViewerHtml}. The iframe is mounted via `srcdoc`, so it inherits
 * the embedder origin; the policy keeps it locked down to:
 *
 * - external module bootstrap script (`bootstrap.mjs`) + local vendored noVNC
 *   (`file:`, loopback `http:`) — no remote script origins; per-session
 *   config rides in a JSON `<script>` data block (never executed, so it
 *   needs no `script-src` allowance),
 * - WebSocket connections back to the loopback sidecar proxy,
 * - inline styles only (noVNC sets canvas styles inline),
 * - no images/fonts except in-memory `data:`/`blob:` payloads,
 * - no forms, objects, or framing by foreign ancestors.
 */
export const VIEWER_IFRAME_CSP = [
  "default-src 'none'",
  "script-src 'self' file: http://127.0.0.1:* http://localhost:*",
  "style-src 'unsafe-inline'",
  "connect-src ws://127.0.0.1:* ws://localhost:* wss://127.0.0.1:* wss://localhost:* http://127.0.0.1:* http://localhost:* file:",
  "img-src data: blob:",
  "font-src data:",
  "media-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  // NOTE: no `frame-ancestors` here. This policy is delivered via a
  // `<meta http-equiv>` tag, and per the CSP spec `frame-ancestors` is
  // ignored in meta-delivered policies (Chromium logs a console warning).
  // The iframe is srcdoc-generated by the desktop app itself, so the only
  // possible parent is our own renderer window.
].join("; ");

export function createViewerHtml(config: ViewerShellConfig): string {
  const payload = escapeJson(config);
  const bootstrapScript = escapeAttr(config.bootstrapScriptUrl);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover"
    />
    <meta http-equiv="Content-Security-Policy" content="${VIEWER_IFRAME_CSP}" />
    <style>
      :root {
        color-scheme: light dark;
        font-family: "Inter", "IBM Plex Sans", system-ui, sans-serif;
        --viewer-background: #F2F4F8;
        --viewer-surface: rgba(255, 255, 255, 0.94);
        --viewer-border: rgba(14, 26, 43, 0.12);
        --viewer-ink: #0E1A2B;
        background: var(--viewer-background);
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --viewer-background: #080C12;
          --viewer-surface: rgba(22, 29, 42, 0.94);
          --viewer-border: rgba(244, 247, 251, 0.12);
          --viewer-ink: #F4F7FB;
          background: var(--viewer-background);
        }
      }
      html,
      body,
      #viewer {
        width: 100%;
        height: 100%;
        margin: 0;
        overflow: hidden;
      }
      body {
        background: var(--viewer-background);
      }
      /* noVNC centers the canvas with margin:auto inside this box. */
      #viewer {
        display: flex;
        align-items: center;
        justify-content: center;
        /* Every touch gesture is the viewer's: no browser scroll, zoom,
           text selection, or long-press callout. */
        touch-action: none;
        user-select: none;
        -webkit-user-select: none;
        -webkit-touch-callout: none;
      }
      #status {
        position: fixed;
        top: 12px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 10;
        padding: 6px 14px;
        border-radius: 999px;
        border: 1px solid var(--viewer-border);
        background: var(--viewer-surface);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        color: var(--viewer-ink);
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        opacity: 1;
        transition: opacity 0.5s ease;
        pointer-events: none;
      }
      #status.hidden {
        opacity: 0;
      }
    </style>
  </head>
  <body>
    <div id="status">Connecting</div>
    <div id="viewer"></div>
    <script type="application/json" id="viewer-config">${payload}</script>
    <script type="module" src="${bootstrapScript}"></script>
  </body>
</html>`;
}
