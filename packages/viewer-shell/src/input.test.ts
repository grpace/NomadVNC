import { beforeEach, describe, expect, it } from "vitest";
import {
  DEAD_MS,
  PROBE_AFTER_QUIET_MS,
  STALLED_MS,
  createLinkMonitor,
  type LinkHealth,
  BUTTON_LEFT,
  BUTTON_MIDDLE,
  BUTTON_RIGHT,
  DOUBLE_TAP_MS,
  LONG_PRESS_MS,
  MULTI_TAP_MAX_MS,
  createTouchController,
  keysymForChar,
  keysymsForText,
  trackpadGain,
  type PointerMode,
  type TouchController,
} from "./input.mjs";

type Call = [string, ...number[]] | [string, number, boolean];

function harness(mode: PointerMode, canPan = false) {
  let clock = 1000;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let nextId = 1;
  const calls: Call[] = [];
  const controller = createTouchController({
    mode,
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: clock + ms, fn, id });
      return id;
    },
    clearTimer: (id) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    actions: {
      pointTo: (x, y) => calls.push(["pointTo", x, y]),
      moveBy: (dx, dy) => calls.push(["moveBy", dx, dy]),
      button: (b, down) => calls.push(["button", b, down]),
      scroll: (sx, sy) => calls.push(["scroll", sx, sy]),
      zoom: (f, x, y) => calls.push(["zoom", f, x, y]),
      pan: (dx, dy) => calls.push(["pan", dx, dy]),
      canPan: () => canPan,
      longPress: () => calls.push(["longPress"]),
    },
  });
  const advance = (ms: number) => {
    clock += ms;
    for (const t of [...timers]) {
      if (t.at <= clock) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    }
  };
  return { controller, calls, advance };
}

const pt = (id: number, x: number, y: number) => ({ id, x, y });

function tap(c: TouchController, x: number, y: number) {
  c.touchStart([pt(1, x, y)]);
  c.touchEnd([pt(1, x, y)]);
}

const buttons = (calls: Call[]) => calls.filter((c) => c[0] === "button");

describe("touch mode", () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness("touch");
  });

  it("tap = left click where the finger is", () => {
    tap(h.controller, 100, 200);
    expect(h.calls).toEqual([
      ["pointTo", 100, 200],
      ["button", BUTTON_LEFT, true],
      ["button", BUTTON_LEFT, false],
    ]);
  });

  it("double tap clicks the same spot twice despite jitter", () => {
    tap(h.controller, 100, 200);
    h.advance(120);
    tap(h.controller, 108, 205);
    expect(h.calls.filter((c) => c[0] === "pointTo")).toEqual([
      ["pointTo", 100, 200],
      ["pointTo", 100, 200],
    ]);
    expect(buttons(h.calls)).toHaveLength(4);
  });

  it("two-finger tap = right click at the fingers' centre", () => {
    h.controller.touchStart([pt(1, 100, 100)]);
    h.controller.touchStart([pt(2, 140, 100)]);
    h.advance(80);
    h.controller.touchEnd([pt(1, 100, 100), pt(2, 140, 100)]);
    expect(h.calls).toEqual([
      ["pointTo", 120, 100],
      ["button", BUTTON_RIGHT, true],
      ["button", BUTTON_RIGHT, false],
    ]);
  });

  it("three-finger tap = middle click", () => {
    h.controller.touchStart([pt(1, 100, 100), pt(2, 140, 100), pt(3, 180, 100)]);
    h.controller.touchEnd([pt(1, 0, 0)]);
    h.controller.touchEnd([pt(2, 0, 0), pt(3, 0, 0)]);
    expect(buttons(h.calls)).toEqual([
      ["button", BUTTON_MIDDLE, true],
      ["button", BUTTON_MIDDLE, false],
    ]);
  });

  it("multi-finger touches held too long are not clicks", () => {
    h.controller.touchStart([pt(1, 100, 100), pt(2, 140, 100)]);
    h.advance(MULTI_TAP_MAX_MS + 50);
    h.controller.touchEnd([pt(1, 0, 0), pt(2, 0, 0)]);
    expect(buttons(h.calls)).toEqual([]);
  });

  it("long press = right click on release", () => {
    h.controller.touchStart([pt(1, 50, 60)]);
    h.advance(LONG_PRESS_MS + 10);
    h.controller.touchEnd([pt(1, 50, 60)]);
    expect(h.calls).toEqual([
      ["pointTo", 50, 60],
      ["longPress"],
      ["button", BUTTON_RIGHT, true],
      ["button", BUTTON_RIGHT, false],
    ]);
  });

  it("long press then drag = left-button drag", () => {
    h.controller.touchStart([pt(1, 50, 60)]);
    h.advance(LONG_PRESS_MS + 10);
    h.controller.touchMove([pt(1, 90, 60)]);
    h.controller.touchMove([pt(1, 120, 80)]);
    h.controller.touchEnd([pt(1, 120, 80)]);
    expect(h.calls).toEqual([
      ["pointTo", 50, 60],
      ["longPress"],
      ["pointTo", 50, 60],
      ["button", BUTTON_LEFT, true],
      ["pointTo", 90, 60],
      ["pointTo", 120, 80],
      ["button", BUTTON_LEFT, false],
    ]);
  });

  it("tap, then touch and drag = left-button drag from the tap", () => {
    tap(h.controller, 100, 100);
    h.advance(DOUBLE_TAP_MS - 100);
    h.calls.length = 0;
    h.controller.touchStart([pt(1, 104, 102)]);
    h.controller.touchMove([pt(1, 160, 100)]);
    h.controller.touchEnd([pt(1, 160, 100)]);
    expect(h.calls).toEqual([
      ["pointTo", 100, 100],
      ["button", BUTTON_LEFT, true],
      ["pointTo", 160, 100],
      ["button", BUTTON_LEFT, false],
    ]);
  });

  it("a slow second touch is a fresh gesture, not a drag", () => {
    tap(h.controller, 100, 100);
    h.advance(DOUBLE_TAP_MS + 50);
    h.calls.length = 0;
    h.controller.touchStart([pt(1, 100, 100)]);
    h.controller.touchMove([pt(1, 160, 100)]);
    h.controller.touchEnd([pt(1, 160, 100)]);
    expect(buttons(h.calls)).toEqual([]);
  });

  it("one-finger drag hovers when the view fits the screen", () => {
    h.controller.touchStart([pt(1, 10, 10)]);
    h.controller.touchMove([pt(1, 40, 10)]);
    h.controller.touchEnd([pt(1, 40, 10)]);
    expect(h.calls).toEqual([["pointTo", 40, 10]]);
  });

  it("one-finger drag pans when zoomed in", () => {
    const z = harness("touch", true);
    z.controller.touchStart([pt(1, 10, 10)]);
    z.controller.touchMove([pt(1, 40, 15)]);
    z.controller.touchMove([pt(1, 50, 25)]);
    z.controller.touchEnd([pt(1, 50, 25)]);
    expect(z.calls).toEqual([
      ["pan", 30, 5],
      ["pan", 10, 10],
    ]);
  });

  it("small finger wobble is still a tap", () => {
    h.controller.touchStart([pt(1, 100, 100)]);
    h.controller.touchMove([pt(1, 106, 104)]);
    h.controller.touchEnd([pt(1, 106, 104)]);
    expect(buttons(h.calls)).toHaveLength(2);
  });
});

describe("two-finger gestures", () => {
  it("two-finger drag scrolls naturally (fingers up = wheel down)", () => {
    const h = harness("touch");
    h.controller.touchStart([pt(1, 100, 300), pt(2, 160, 300)]);
    h.controller.touchMove([pt(1, 100, 280), pt(2, 160, 280)]); // decides "scroll"
    h.controller.touchMove([pt(1, 100, 215), pt(2, 160, 215)]); // 65px up
    h.controller.touchEnd([pt(1, 0, 0), pt(2, 0, 0)]);
    // Touch mode scrolls under the fingers (where they started).
    expect(h.calls).toEqual([
      ["pointTo", 130, 300],
      ["scroll", 0, 2],
    ]);
  });

  it("horizontal two-finger drag scrolls sideways", () => {
    const h = harness("trackpad");
    h.controller.touchStart([pt(1, 100, 300), pt(2, 100, 360)]);
    h.controller.touchMove([pt(1, 120, 300), pt(2, 120, 360)]);
    h.controller.touchMove([pt(1, 160, 300), pt(2, 160, 360)]);
    h.controller.touchEnd([pt(1, 0, 0), pt(2, 0, 0)]);
    expect(h.calls).toEqual([["scroll", -1, 0]]);
  });

  it("pinch zooms the view around the fingers and pans with them", () => {
    const h = harness("touch");
    h.controller.touchStart([pt(1, 100, 100), pt(2, 200, 100)]);
    h.controller.touchMove([pt(1, 70, 100), pt(2, 230, 100)]); // spread 100 → 160: decides pinch
    h.controller.touchMove([pt(1, 60, 110), pt(2, 260, 110)]); // spread 200, centre moves
    h.controller.touchEnd([pt(1, 0, 0), pt(2, 0, 0)]);
    expect(h.calls[0]).toEqual(["zoom", 200 / 160, 160, 110]);
    expect(h.calls).toContainEqual(["pan", 10, 10]);
    expect(buttons(h.calls)).toEqual([]);
  });

  it("pinch decides before scroll when fingers spread", () => {
    const h = harness("trackpad");
    h.controller.touchStart([pt(1, 100, 100), pt(2, 200, 100)]);
    h.controller.touchMove([pt(1, 50, 100), pt(2, 250, 100)]);
    h.controller.touchMove([pt(1, 25, 100), pt(2, 275, 100)]);
    expect(h.calls).toContainEqual(["zoom", 250 / 200, 150, 100]);
    expect(h.calls.some((c) => c[0] === "scroll")).toBe(false);
  });
});

describe("trackpad mode", () => {
  it("tap clicks at the pointer without moving it", () => {
    const h = harness("trackpad");
    tap(h.controller, 300, 300);
    expect(h.calls).toEqual([
      ["button", BUTTON_LEFT, true],
      ["button", BUTTON_LEFT, false],
    ]);
  });

  it("one finger moves the pointer relatively", () => {
    const h = harness("trackpad", true);
    h.controller.touchStart([pt(1, 100, 100)]);
    h.advance(100);
    h.controller.touchMove([pt(1, 120, 100)]); // past slop: starts "move"
    h.advance(100);
    h.controller.touchMove([pt(1, 125, 103)]);
    h.controller.touchEnd([pt(1, 125, 103)]);
    expect(h.calls).toEqual([
      ["moveBy", 20, 0],
      ["moveBy", 5, 3],
    ]);
  });

  it("two-finger tap = right click at the pointer", () => {
    const h = harness("trackpad");
    h.controller.touchStart([pt(1, 100, 100), pt(2, 150, 100)]);
    h.controller.touchEnd([pt(1, 0, 0), pt(2, 0, 0)]);
    expect(h.calls).toEqual([
      ["button", BUTTON_RIGHT, true],
      ["button", BUTTON_RIGHT, false],
    ]);
  });

  it("tap-and-drag holds the left button while moving", () => {
    const h = harness("trackpad");
    tap(h.controller, 100, 100);
    h.advance(150);
    h.calls.length = 0;
    h.controller.touchStart([pt(1, 140, 120)]); // anywhere nearby
    h.advance(100);
    h.controller.touchMove([pt(1, 170, 120)]);
    h.controller.touchEnd([pt(1, 170, 120)]);
    expect(h.calls).toEqual([
      ["button", BUTTON_LEFT, true],
      ["moveBy", 30, 0],
      ["button", BUTTON_LEFT, false],
    ]);
  });

  it("switching modes drops any gesture in progress safely", () => {
    const h = harness("trackpad");
    tap(h.controller, 100, 100);
    h.controller.touchStart([pt(1, 100, 100)]);
    h.advance(50);
    h.controller.touchMove([pt(1, 150, 100)]); // drag: left button down
    h.controller.setMode("touch");
    expect(h.calls.at(-1)).toEqual(["button", BUTTON_LEFT, false]);
    expect(h.controller.mode).toBe("touch");
  });
});

describe("trackpadGain", () => {
  it("is 1:1 for slow movement and capped for flicks", () => {
    expect(trackpadGain(5, 50)).toBe(1);
    expect(trackpadGain(100, 50)).toBeGreaterThan(2);
    expect(trackpadGain(10000, 1)).toBe(3);
  });
});

describe("keysyms", () => {
  it("maps printable Latin-1 directly", () => {
    expect(keysymForChar("a")).toBe(0x61);
    expect(keysymForChar("A")).toBe(0x41);
    expect(keysymForChar(" ")).toBe(0x20);
    expect(keysymForChar("é")).toBe(0xe9);
  });

  it("maps control characters to their keys", () => {
    expect(keysymForChar("\n")).toBe(0xff0d);
    expect(keysymForChar("\t")).toBe(0xff09);
    expect(keysymForChar("\b")).toBe(0xff08);
    expect(keysymForChar("\u0001")).toBeNull();
  });

  it("uses Unicode keysyms beyond Latin-1, including astral characters", () => {
    expect(keysymForChar("€")).toBe(0x010020ac);
    expect(keysymForChar("😀")).toBe(0x0101f600);
  });

  it("types text with CRLF as a single Return", () => {
    expect(keysymsForText("hi\r\nyo")).toEqual([0x68, 0x69, 0xff0d, 0x79, 0x6f]);
  });
});

describe("link monitor", () => {
  function setup() {
    let clock = 0;
    const probes: number[] = [];
    const health: LinkHealth[] = [];
    let deaths = 0;
    let refreshes = 0;
    const monitor = createLinkMonitor({
      now: () => clock,
      sendProbe: () => probes.push(clock),
      sendRefresh: () => {
        refreshes += 1;
      },
      onHealth: (h) => health.push(h),
      onDead: () => {
        deaths += 1;
      },
    });
    /** Advances the clock in 1s ticks, like the bootstrap's interval. */
    const run = (ms: number) => {
      for (let t = 0; t < ms; t += 1000) {
        clock += 1000;
        monitor.tick();
      }
    };
    const at = (ms: number) => {
      clock += ms;
    };
    return { monitor, probes, health, run, at, deaths: () => deaths, refreshes: () => refreshes };
  }

  it("probes only after a quiet spell", () => {
    const h = setup();
    h.run(2000);
    expect(h.probes).toHaveLength(0);
    h.run(1000);
    expect(h.probes).toHaveLength(1);
    // Data keeps flowing: no more probes.
    for (let i = 0; i < 5; i += 1) {
      h.monitor.received();
      h.run(1000);
    }
    expect(h.probes).toHaveLength(1);
  });

  it("reports latency from a quick reply and stays good", () => {
    const h = setup();
    h.run(PROBE_AFTER_QUIET_MS + 500);
    h.at(40);
    h.monitor.received();
    expect(h.monitor.health).toBe("good");
    expect(h.health).toEqual([{ state: "good", latencyMs: 40 }]);
  });

  it("calls a slow reply slow", () => {
    const h = setup();
    h.run(3000);
    h.at(900);
    h.monitor.received();
    expect(h.health.at(-1)).toEqual({ state: "slow", latencyMs: 900 });
  });

  it("marks an unanswered probe slow, then stalled, then dead once", () => {
    const h = setup();
    h.run(3000);
    h.run(2000);
    expect(h.health.at(-1)).toEqual({ state: "slow" });
    h.run(STALLED_MS);
    expect(h.health.at(-1)).toEqual({ state: "stalled" });
    expect(h.deaths()).toBe(0);
    // One full-screen request before giving up, not one per tick.
    expect(h.refreshes()).toBe(1);
    h.run(DEAD_MS);
    expect(h.deaths()).toBe(1);
    h.run(DEAD_MS);
    h.monitor.received();
    expect(h.deaths()).toBe(1);
  });

  it("recovers from stalled when the reply finally arrives", () => {
    const h = setup();
    h.run(3000 + STALLED_MS + 1000);
    expect(h.monitor.health).toBe("stalled");
    h.monitor.received();
    expect(h.monitor.health).toBe("slow");
    h.run(3000);
    h.at(30);
    h.monitor.received();
    // Smoothed latency comes down over a few quick replies.
    for (let i = 0; i < 10; i += 1) {
      h.run(3000);
      h.at(30);
      h.monitor.received();
    }
    expect(h.monitor.health).toBe("good");
  });

  it("does not count frozen timers as silence", () => {
    const h = setup();
    h.run(3000);
    expect(h.probes).toHaveLength(1);
    // The app was in the background for a minute.
    h.at(60_000);
    h.monitor.tick();
    expect(h.deaths()).toBe(0);
    expect(h.monitor.health).toBe("good");
    h.run(2000);
    expect(h.probes).toHaveLength(1);
    h.run(1000);
    expect(h.probes).toHaveLength(2);
  });

  it("sends at most one probe at a time", () => {
    const h = setup();
    h.monitor.probe();
    h.monitor.probe();
    h.run(4000);
    expect(h.probes).toHaveLength(1);
  });
});
