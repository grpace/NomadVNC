/**
 * Automatic reconnection for dropped VNC sessions.
 *
 * When the viewer reports an unexpected disconnect, the app retries with
 * exponential backoff instead of immediately dumping the user on the manual
 * "Connection lost" overlay. The overlay appears only when the retry budget
 * is exhausted. Drops that are known permanent (e.g. the tailnet peer is
 * offline) skip the loop entirely — the caller decides that, not this module.
 *
 * The budget is driven by viewer events, not by proxy-start failures: the
 * sidecar dials the VNC target lazily when the viewer's WebSocket connects,
 * so a dead server surfaces as another viewer "disconnected" event rather
 * than a rejected attempt. Each such event while a loop is active counts
 * against the SAME budget — only a "connected" (successful RFB handshake)
 * resets it.
 */

export const AUTO_RECONNECT_MAX_ATTEMPTS = 5;
const AUTO_RECONNECT_BASE_DELAY_MS = 1000;
const AUTO_RECONNECT_MAX_DELAY_MS = 15_000;
/**
 * Bounds a single attempt: proxy start + viewer remount + RFB handshake.
 * Firing means the attempt stalled (no viewer event), so it counts as failed.
 */
export const AUTO_RECONNECT_ATTEMPT_TIMEOUT_MS = 20_000;

/** Backoff for attempt n (1-based): 1s, 2s, 4s, 8s, then capped at 15s. */
export function autoReconnectDelayMs(attempt: number): number {
  if (attempt < 1) {
    return AUTO_RECONNECT_BASE_DELAY_MS;
  }
  return Math.min(AUTO_RECONNECT_BASE_DELAY_MS * 2 ** (attempt - 1), AUTO_RECONNECT_MAX_DELAY_MS);
}

export interface SessionReconnectDeps {
  /**
   * Starts a replacement proxy session and remounts the viewer. Resolves
   * once the replacement is issued — success or failure of the VNC dial is
   * observed later via viewer events. Rejects only when the proxy itself
   * cannot start (sidecar/IPC failure).
   */
  attempt: () => Promise<void>;
  /** All attempts failed — the UI should surface the manual reconnect path. */
  onExhausted: () => void;
  /** A retry was scheduled (drives the "retrying (n/5)…" status). */
  onAttemptScheduled?: (attempt: number, delayMs: number) => void;
  /** The OS network dropped mid-retry: paused without burning the budget. */
  onNetworkOffline?: () => void;
}

/**
 * Retry loop with exponential backoff, driven by viewer events.
 *
 * - `noteDisconnected()` starts a fresh budget for a new drop, or counts the
 *   in-flight attempt as failed when a loop is already running.
 * - `noteConnected()` ends the loop: the session is healthy again.
 * - `stop()` cancels everything (user disconnected, manual reconnect, unmount).
 * - `noteNetworkOffline()` pauses the loop without consuming the budget;
 *   `noteNetworkOnline()` resumes with a fresh budget.
 */
export class SessionReconnectController {
  private retryTimer: number | null = null;
  private watchdogTimer: number | null = null;
  private attempts = 0;
  private active = false;
  private pausedForOffline = false;

  constructor(private readonly deps: SessionReconnectDeps) {}

  /** A retry is scheduled and waiting to fire. */
  get isScheduled(): boolean {
    return this.retryTimer !== null;
  }

  /** Attempts consumed in the current budget (0 when idle). */
  get attemptCount(): number {
    return this.attempts;
  }

  /** A retry loop is in progress (including paused-for-offline). */
  get isActive(): boolean {
    return this.active;
  }

  noteDisconnected(): void {
    if (!this.active) {
      this.active = true;
      this.attempts = 0;
      if (this.isBrowserOffline()) {
        // No point scheduling dials with no network: wait for it to return.
        this.pausedForOffline = true;
        this.deps.onNetworkOffline?.();
        return;
      }
      this.registerFailure();
      return;
    }
    if (this.pausedForOffline || this.retryTimer !== null) {
      // Stale or duplicate event: no attempt is in flight.
      return;
    }
    // The in-flight attempt's viewer just reported its failure.
    this.registerFailure();
  }

  noteConnected(): void {
    this.stop();
  }

  noteNetworkOffline(): void {
    if (!this.active || this.pausedForOffline) {
      return;
    }
    this.clearTimers();
    this.pausedForOffline = true;
    this.deps.onNetworkOffline?.();
  }

  noteNetworkOnline(): void {
    if (!this.pausedForOffline) {
      return;
    }
    this.pausedForOffline = false;
    if (!this.active) {
      return;
    }
    // The outage wasn't the server's fault: resume with a fresh budget.
    this.attempts = 0;
    this.registerFailure();
  }

  stop(): void {
    this.clearTimers();
    this.active = false;
    this.attempts = 0;
    this.pausedForOffline = false;
  }

  private isBrowserOffline(): boolean {
    return typeof navigator !== "undefined" && navigator.onLine === false;
  }

  private clearTimers(): void {
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.watchdogTimer !== null) {
      window.clearTimeout(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /** Counts one failed attempt and schedules the next, or gives up. */
  private registerFailure(): void {
    if (!this.active || this.pausedForOffline) {
      return;
    }
    this.clearTimers();
    const next = this.attempts + 1;
    if (next > AUTO_RECONNECT_MAX_ATTEMPTS) {
      this.active = false;
      this.attempts = 0;
      this.deps.onExhausted();
      return;
    }
    this.attempts = next;
    const delayMs = autoReconnectDelayMs(next);
    this.deps.onAttemptScheduled?.(next, delayMs);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      void this.fireAttempt();
    }, delayMs);
  }

  private async fireAttempt(): Promise<void> {
    if (!this.active || this.pausedForOffline) {
      return;
    }
    // Bound the attempt: a viewer event (connected/disconnected) disarms
    // this; firing means the attempt stalled, so count it as failed.
    this.watchdogTimer = window.setTimeout(() => {
      this.watchdogTimer = null;
      this.registerFailure();
    }, AUTO_RECONNECT_ATTEMPT_TIMEOUT_MS);
    try {
      await this.deps.attempt();
    } catch {
      // No viewer event will follow a failed proxy start — count it here.
      this.registerFailure();
    }
  }
}
