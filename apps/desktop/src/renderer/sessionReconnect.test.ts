import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTO_RECONNECT_ATTEMPT_TIMEOUT_MS,
  AUTO_RECONNECT_MAX_ATTEMPTS,
  autoReconnectDelayMs,
  SessionReconnectController,
} from "./sessionReconnect";

describe("autoReconnectDelayMs", () => {
  it("backs off exponentially and caps at 15s", () => {
    expect(autoReconnectDelayMs(1)).toBe(1000);
    expect(autoReconnectDelayMs(2)).toBe(2000);
    expect(autoReconnectDelayMs(3)).toBe(4000);
    expect(autoReconnectDelayMs(4)).toBe(8000);
    // 2^4 * 1000 = 16000 would exceed the cap.
    expect(autoReconnectDelayMs(5)).toBe(15000);
    expect(autoReconnectDelayMs(6)).toBe(15000);
  });

  it("clamps non-positive attempts to the base delay", () => {
    expect(autoReconnectDelayMs(0)).toBe(1000);
  });
});

describe("SessionReconnectController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setBrowserOnline(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    setBrowserOnline(true);
  });

  function setBrowserOnline(online: boolean): void {
    Object.defineProperty(window.navigator, "onLine", { value: online, configurable: true });
  }

  function setup(attemptImpl?: () => Promise<void>) {
    const attempt = vi.fn(attemptImpl ?? (async () => {}));
    const onExhausted = vi.fn();
    const onAttemptScheduled = vi.fn();
    const onNetworkOffline = vi.fn();
    const controller = new SessionReconnectController({
      attempt,
      onExhausted,
      onAttemptScheduled,
      onNetworkOffline,
    });
    return { controller, attempt, onExhausted, onAttemptScheduled, onNetworkOffline };
  }

  it("schedules the first attempt 1s after a drop", () => {
    const { controller, attempt, onAttemptScheduled } = setup();
    controller.noteDisconnected();
    expect(onAttemptScheduled).toHaveBeenCalledWith(1, 1000);
    expect(attempt).not.toHaveBeenCalled();
    expect(controller.isScheduled).toBe(true);
    expect(controller.isActive).toBe(true);

    vi.advanceTimersByTime(1000);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("counts viewer-reported failures against the same budget", async () => {
    // The realistic path: the proxy starts fine (the sidecar dials lazily),
    // so each failure comes back as another viewer "disconnected" event.
    const { controller, attempt, onExhausted, onAttemptScheduled } = setup();
    controller.noteDisconnected();
    expect(controller.attemptCount).toBe(1);

    for (let n = 1; n <= AUTO_RECONNECT_MAX_ATTEMPTS; n += 1) {
      expect(onAttemptScheduled).toHaveBeenLastCalledWith(n, autoReconnectDelayMs(n));
      await vi.advanceTimersByTimeAsync(autoReconnectDelayMs(n));
      expect(attempt).toHaveBeenCalledTimes(n);
      // The attempt's viewer reports its failure: same budget continues.
      controller.noteDisconnected();
    }

    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(controller.isScheduled).toBe(false);
    expect(controller.attemptCount).toBe(0);
    expect(controller.isActive).toBe(false);

    // No further attempts are scheduled after exhaustion.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(attempt).toHaveBeenCalledTimes(AUTO_RECONNECT_MAX_ATTEMPTS);
    expect(onExhausted).toHaveBeenCalledTimes(1);
  });

  it("resets the budget only on a successful connection", async () => {
    const { controller, attempt, onExhausted, onAttemptScheduled } = setup();
    controller.noteDisconnected();
    await vi.advanceTimersByTimeAsync(1000);
    expect(attempt).toHaveBeenCalledTimes(1);

    // The attempt's viewer fails: the budget continues, not restarts.
    controller.noteDisconnected();
    expect(onAttemptScheduled).toHaveBeenLastCalledWith(2, 2000);
    expect(controller.attemptCount).toBe(2);

    // A genuinely new drop after a successful connection starts fresh.
    controller.noteConnected();
    expect(controller.isActive).toBe(false);
    controller.noteDisconnected();
    expect(onAttemptScheduled).toHaveBeenLastCalledWith(1, 1000);

    controller.noteConnected();
    expect(onExhausted).not.toHaveBeenCalled();
    expect(controller.isScheduled).toBe(false);
  });

  it("ignores duplicate disconnects while a retry is queued", async () => {
    const { controller, attempt, onAttemptScheduled } = setup();
    controller.noteDisconnected();
    expect(onAttemptScheduled).toHaveBeenCalledTimes(1);

    // A stale duplicate (e.g. the old iframe's in-flight message) must not
    // consume another budget slot while attempt 1 is still queued.
    controller.noteDisconnected();
    expect(onAttemptScheduled).toHaveBeenCalledTimes(1);
    expect(controller.attemptCount).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("counts a rejected proxy start as a failed attempt", async () => {
    const { controller, attempt, onExhausted, onAttemptScheduled } = setup(async () => {
      throw new Error("sidecar down");
    });
    controller.noteDisconnected();

    for (let n = 1; n <= AUTO_RECONNECT_MAX_ATTEMPTS; n += 1) {
      await vi.advanceTimersByTimeAsync(autoReconnectDelayMs(n));
      expect(attempt).toHaveBeenCalledTimes(n);
    }

    expect(onExhausted).toHaveBeenCalledTimes(1);
    expect(onAttemptScheduled).toHaveBeenCalledTimes(AUTO_RECONNECT_MAX_ATTEMPTS);
  });

  it("counts a stalled attempt (no viewer event) as failed", async () => {
    const { controller, attempt, onAttemptScheduled } = setup(async () => {
      // Proxy starts fine, but the viewer never reports back.
    });
    controller.noteDisconnected();
    await vi.advanceTimersByTimeAsync(1000);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(onAttemptScheduled).toHaveBeenCalledTimes(1);

    // The watchdog fires: the stalled attempt counts against the budget.
    await vi.advanceTimersByTimeAsync(AUTO_RECONNECT_ATTEMPT_TIMEOUT_MS);
    expect(onAttemptScheduled).toHaveBeenCalledWith(2, 2000);
    expect(controller.attemptCount).toBe(2);
  });

  it("pauses on network loss and resumes with a fresh budget", async () => {
    const { controller, attempt, onAttemptScheduled, onNetworkOffline } = setup();
    controller.noteDisconnected();
    expect(onAttemptScheduled).toHaveBeenCalledWith(1, 1000);

    controller.noteNetworkOffline();
    expect(onNetworkOffline).toHaveBeenCalledTimes(1);
    expect(controller.isScheduled).toBe(false);
    expect(controller.isActive).toBe(true);

    // Retries are paused: nothing fires while offline.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(attempt).not.toHaveBeenCalled();

    // A stale disconnect during the outage must not burn the budget.
    controller.noteDisconnected();
    expect(onAttemptScheduled).toHaveBeenCalledTimes(1);

    controller.noteNetworkOnline();
    expect(onAttemptScheduled).toHaveBeenLastCalledWith(1, 1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("starts paused when the browser is already offline", () => {
    setBrowserOnline(false);
    const { controller, attempt, onAttemptScheduled, onNetworkOffline } = setup();
    controller.noteDisconnected();
    expect(onNetworkOffline).toHaveBeenCalledTimes(1);
    expect(onAttemptScheduled).not.toHaveBeenCalled();
    expect(controller.isScheduled).toBe(false);

    setBrowserOnline(true);
    controller.noteNetworkOnline();
    expect(onAttemptScheduled).toHaveBeenCalledWith(1, 1000);
    expect(attempt).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("stop() cancels everything, including a paused loop", async () => {
    const { controller, attempt, onExhausted, onNetworkOffline } = setup();
    controller.noteDisconnected();
    controller.noteNetworkOffline();
    expect(onNetworkOffline).toHaveBeenCalledTimes(1);

    controller.stop();
    expect(controller.isActive).toBe(false);
    expect(controller.isScheduled).toBe(false);

    // Coming back online after a stop must not resurrect the loop.
    controller.noteNetworkOnline();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(attempt).not.toHaveBeenCalled();
    expect(onExhausted).not.toHaveBeenCalled();
  });
});
