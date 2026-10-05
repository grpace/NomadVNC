// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  enforceSingleInstance,
  type SingleInstanceApp,
  type SingleInstanceWindow,
} from "./singleInstance";

interface FakeApp extends SingleInstanceApp {
  listeners: Map<string, () => void>;
  quitCalls: number;
}

function createFakeApp(lockAcquired: boolean): FakeApp {
  return {
    listeners: new Map(),
    quitCalls: 0,
    requestSingleInstanceLock: () => lockAcquired,
    quit() {
      this.quitCalls += 1;
    },
    on(event: "second-instance", listener: () => void) {
      this.listeners.set(event, listener);
    },
  };
}

interface FakeWindow extends SingleInstanceWindow {
  calls: string[];
}

function createFakeWindow(options?: { minimized?: boolean; destroyed?: boolean }): FakeWindow {
  const calls: string[] = [];
  return {
    calls,
    isDestroyed: () => options?.destroyed ?? false,
    isMinimized: () => options?.minimized ?? false,
    restore: () => {
      calls.push("restore");
    },
    focus: () => {
      calls.push("focus");
    },
  };
}

describe("enforceSingleInstance", () => {
  it("returns true and registers a second-instance handler when the lock is acquired", () => {
    const app = createFakeApp(true);
    const result = enforceSingleInstance(app, () => null);
    expect(result).toBe(true);
    expect(app.quitCalls).toBe(0);
    expect(app.listeners.has("second-instance")).toBe(true);
  });

  it("quits and returns false without a handler when the lock is already held", () => {
    const app = createFakeApp(false);
    const result = enforceSingleInstance(app, () => null);
    expect(result).toBe(false);
    expect(app.quitCalls).toBe(1);
    expect(app.listeners.has("second-instance")).toBe(false);
  });

  it("focuses the existing window on second-instance", () => {
    const app = createFakeApp(true);
    const window = createFakeWindow();
    enforceSingleInstance(app, () => window);
    app.listeners.get("second-instance")?.();
    expect(window.calls).toEqual(["focus"]);
  });

  it("restores a minimized window before focusing it", () => {
    const app = createFakeApp(true);
    const window = createFakeWindow({ minimized: true });
    enforceSingleInstance(app, () => window);
    app.listeners.get("second-instance")?.();
    expect(window.calls).toEqual(["restore", "focus"]);
  });

  it("ignores second-instance when the window is destroyed or missing", () => {
    const destroyed = createFakeWindow({ destroyed: true });
    const app = createFakeApp(true);
    enforceSingleInstance(app, () => destroyed);
    app.listeners.get("second-instance")?.();
    expect(destroyed.calls).toEqual([]);

    const app2 = createFakeApp(true);
    const focus = vi.fn();
    enforceSingleInstance(app2, () => null);
    expect(() => app2.listeners.get("second-instance")?.()).not.toThrow();
    expect(focus).not.toHaveBeenCalled();
  });
});
