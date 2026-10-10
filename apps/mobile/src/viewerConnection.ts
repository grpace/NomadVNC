/**
 * Pure connection helpers for the mobile viewer screen.
 * Kept free of React Native imports so the reconnect policy and the
 * viewer-event parsing are unit-testable under node.
 */

/** Mirrors the desktop backoff: 1s/2s/4s/8s/15s, 5 attempts. */
export const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];

/** If the viewer never reports a state after a (re)mount, count it as a dead attempt. */
export const CONNECT_WATCHDOG_MS = 20000;

/**
 * How long to wait for `viewerAlive` after the app returns to the
 * foreground. A live session answers immediately; silence means the
 * WebView was frozen or killed and the session should reconnect in place.
 */
export const RESUME_PROBE_MS = 3000;

/** What to do with an in-progress session when the app becomes active again. */
export type ResumeAction = "probe" | "watch" | "reconnect" | "ignore";

/**
 * Coming back from the app switcher. A live session is probed and kept.
 * A connect that was still loading gets its watchdog back. A reconnect
 * whose wait was frozen while backgrounded runs now. Auth and hard
 * failures stay where they are.
 */
export function resumeActionForState(kind: string): ResumeAction {
  switch (kind) {
    case "connected":
      return "probe";
    case "connecting":
    case "loading":
      return "watch";
    case "reconnecting":
      return "reconnect";
    default:
      return "ignore";
  }
}

/** Maximum automatic reconnect attempts before surfacing manual retry. */
export const MAX_RECONNECT_ATTEMPTS = RECONNECT_DELAYS_MS.length;

export interface ViewerEventData {
  type?: string;
  state?: string;
  text?: string;
  width?: number;
  height?: number;
  /** `viewerZoom`: pinch-zoom level (1 = not zoomed). */
  level?: number;
  /** `viewerAlive`: the RFB socket is still open. */
  live?: boolean;
  /** `viewerHealth`: smoothed probe round trip (ms). */
  latencyMs?: number;
  /** `viewerState: disconnected`: "stalled" when the viewer gave up on a silent link. */
  reason?: string;
}

/** Link health from `viewerHealth` events; null until the first report. */
export interface LinkHealth {
  state: "good" | "slow" | "stalled";
  latencyMs?: number;
}

/** A `viewerHealth` event as LinkHealth, or null if it isn't one. */
export function linkHealthFromEvent(event: ViewerEventData): LinkHealth | null {
  if (event.type !== "viewerHealth") return null;
  if (event.state !== "good" && event.state !== "slow" && event.state !== "stalled") return null;
  return typeof event.latencyMs === "number"
    ? { state: event.state, latencyMs: event.latencyMs }
    : { state: event.state };
}

/**
 * Parses a `window.ReactNativeWebView.postMessage` payload from the viewer.
 * Returns null for anything that isn't a viewer event object.
 */
export function parseViewerEvent(data: string): ViewerEventData | null {
  try {
    const parsed: unknown = JSON.parse(data);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as { type?: unknown }).type === "string"
    ) {
      return parsed as ViewerEventData;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Viewer states that mean "the password is missing or wrong": the screen
 * asks for a password instead of retrying. `authFailed` is the shared
 * viewer's RFB security failure (wrong password); `credentialsRequired`
 * means none was supplied.
 */
export function isCredentialProblem(state: string | undefined): boolean {
  return state === "authFailed" || state === "credentialsRequired";
}

/**
 * Delay before the given reconnect attempt (0-based), or null when the
 * budget is exhausted and the UI should offer manual retry.
 */
export function reconnectDelayForAttempt(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 0) return null;
  return attempt < RECONNECT_DELAYS_MS.length ? RECONNECT_DELAYS_MS[attempt] : null;
}
