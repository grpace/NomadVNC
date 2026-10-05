/**
 * NomadVNC viewer input: touch gestures and text entry.
 *
 * Pure logic — no DOM access at import — so it is unit-tested directly
 * and loaded by the viewer bootstrap at runtime (`config.inputModuleUrl`).
 *
 * The touch controller turns raw touch points into intents (move the
 * pointer, press a button, scroll, zoom or pan the view). The bootstrap
 * maps those intents onto the RFB connection and noVNC's display.
 *
 * Two pointer modes:
 *
 * - "touch": the pointer goes where your finger is. Tap clicks there,
 *   one-finger drag pans the view when zoomed in (otherwise it moves the
 *   pointer, for hover menus).
 * - "trackpad": the screen is a laptop trackpad. One finger moves the
 *   pointer relative to where it is (with acceleration); tap clicks at the
 *   pointer.
 *
 * Shared gestures:
 *
 *   tap                       left click (double-tap = double click)
 *   two-finger tap            right click
 *   three-finger tap          middle click
 *   long press                right click
 *   long press, then drag     click and drag (left button held)
 *   tap, then touch and drag  click and drag (left button held)
 *   two-finger drag           scroll (vertical and horizontal)
 *   pinch                     zoom the view (locally — not the remote screen)
 */

/** How far (px) a finger may wander and still count as a tap or press. */
export const TAP_SLOP = 12;
/** Hold this long (ms) without moving for a long press. */
export const LONG_PRESS_MS = 450;
/** A touch this soon (ms) after a tap, near it, starts tap-and-drag. */
export const DOUBLE_TAP_MS = 320;
/** "Near" for double taps (px) — wider in trackpad mode, where position doesn't matter. */
export const DOUBLE_TAP_SLOP = { touch: 40, trackpad: 120 };
/** Multi-finger taps longer than this (ms) are ignored (fingers resting). */
export const MULTI_TAP_MAX_MS = 600;
/** Two-finger spread change (px) that makes a gesture a pinch, not a scroll. */
export const PINCH_SLOP = 24;
/** Two-finger travel (px) per wheel step. */
export const SCROLL_STEP = 30;

export const BUTTON_LEFT = 0;
export const BUTTON_MIDDLE = 1;
export const BUTTON_RIGHT = 2;

/**
 * Trackpad pointer acceleration: slow movements are 1:1 for precision,
 * fast flicks travel up to 3× further.
 */
export function trackpadGain(distancePx, elapsedMs) {
  const speed = distancePx / Math.max(elapsedMs, 1); // px per ms
  return Math.min(3, 1 + Math.max(0, speed - 0.3) * 1.5);
}

/**
 * @param {{
 *   mode?: "touch" | "trackpad",
 *   actions: {
 *     pointTo(x: number, y: number): void,
 *     moveBy(dx: number, dy: number): void,
 *     button(button: number, down: boolean): void,
 *     scroll(stepsX: number, stepsY: number): void,
 *     zoom(factor: number, x: number, y: number): void,
 *     pan(dx: number, dy: number): void,
 *     canPan(): boolean,
 *     longPress?(): void,
 *   },
 *   now?: () => number,
 *   setTimer?: (fn: () => void, ms: number) => unknown,
 *   clearTimer?: (handle: unknown) => void,
 * }} options
 */
export function createTouchController(options) {
  const actions = options.actions;
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle));
  let mode = options.mode === "trackpad" ? "trackpad" : "touch";

  /** Active touches by identifier: current and last-processed position. */
  const touches = new Map();
  /**
   * The gesture in progress, from first finger down to last finger up.
   * kind: pending → (held | drag | pan | hover | move | scroll | pinch | ignored)
   */
  let gesture = null;
  let longPressTimer = null;
  /** The last single-finger tap (for double-tap snapping and tap-and-drag). */
  let lastTap = null;

  function centroid() {
    let x = 0;
    let y = 0;
    for (const t of touches.values()) {
      x += t.x;
      y += t.y;
    }
    const n = touches.size || 1;
    return { x: x / n, y: y / n };
  }

  function spread() {
    const pts = [...touches.values()];
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  }

  function cancelLongPress() {
    if (longPressTimer !== null) {
      clearTimer(longPressTimer);
      longPressTimer = null;
    }
  }

  /** Re-baselines multi-finger tracking when fingers are added or lifted. */
  function rebaseline() {
    if (!gesture) return;
    const c = centroid();
    gesture.lastX = c.x;
    gesture.lastY = c.y;
    gesture.lastSpread = spread();
  }

  function nearLastTap(x, y) {
    if (!lastTap || now() - lastTap.time > DOUBLE_TAP_MS) return false;
    return Math.hypot(x - lastTap.x, y - lastTap.y) <= DOUBLE_TAP_SLOP[mode];
  }

  function beginDrag() {
    if (mode === "touch") actions.pointTo(gesture.startX, gesture.startY);
    actions.button(BUTTON_LEFT, true);
    gesture.kind = "drag";
  }

  function onLongPress() {
    longPressTimer = null;
    if (!gesture || gesture.kind !== "pending" || touches.size !== 1 || gesture.maxFingers !== 1) {
      return;
    }
    gesture.kind = "held";
    if (mode === "touch") actions.pointTo(gesture.startX, gesture.startY);
    actions.longPress?.();
  }

  function moveSingle(c) {
    const dx = c.x - gesture.lastX;
    const dy = c.y - gesture.lastY;
    const t = now();
    const dt = t - gesture.lastTime;
    gesture.lastX = c.x;
    gesture.lastY = c.y;
    gesture.lastTime = t;
    if (dx === 0 && dy === 0) return;
    switch (gesture.kind) {
      case "pan":
        actions.pan(dx, dy);
        break;
      case "hover":
        actions.pointTo(c.x, c.y);
        break;
      case "move":
      case "drag":
        if (mode === "touch") {
          actions.pointTo(c.x, c.y);
        } else {
          const gain = trackpadGain(Math.hypot(dx, dy), dt);
          actions.moveBy(dx * gain, dy * gain);
        }
        break;
    }
  }

  function moveMulti(c) {
    const dx = c.x - gesture.lastX;
    const dy = c.y - gesture.lastY;
    gesture.lastX = c.x;
    gesture.lastY = c.y;
    if (gesture.kind === "pinch") {
      const s = spread();
      if (gesture.lastSpread > 0 && s > 0) {
        actions.zoom(s / gesture.lastSpread, c.x, c.y);
      }
      gesture.lastSpread = s;
      if (dx !== 0 || dy !== 0) actions.pan(dx, dy);
    } else if (gesture.kind === "scroll") {
      // Natural scrolling, like a phone: fingers move up, content moves up
      // (wheel down). Positive steps = down / right.
      gesture.scrollX -= dx;
      gesture.scrollY -= dy;
      let stepsX = 0;
      let stepsY = 0;
      while (Math.abs(gesture.scrollX) >= SCROLL_STEP) {
        const dir = Math.sign(gesture.scrollX);
        stepsX += dir;
        gesture.scrollX -= dir * SCROLL_STEP;
      }
      while (Math.abs(gesture.scrollY) >= SCROLL_STEP) {
        const dir = Math.sign(gesture.scrollY);
        stepsY += dir;
        gesture.scrollY -= dir * SCROLL_STEP;
      }
      if (stepsX !== 0 || stepsY !== 0) actions.scroll(stepsX, stepsY);
    }
  }

  function touchStart(changed) {
    for (const t of changed) touches.set(t.id, { x: t.x, y: t.y });
    const c = centroid();
    if (!gesture) {
      gesture = {
        kind: "pending",
        maxFingers: touches.size,
        startTime: now(),
        startX: c.x,
        startY: c.y,
        lastX: c.x,
        lastY: c.y,
        lastTime: now(),
        lastSpread: spread(),
        scrollX: 0,
        scrollY: 0,
        tapAndDrag: touches.size === 1 && nearLastTap(c.x, c.y),
      };
      if (gesture.tapAndDrag && mode === "touch") {
        // Second tap of a double tap lands on the first one's spot, so
        // double-clicks hit the same pixel despite finger jitter.
        gesture.startX = lastTap.x;
        gesture.startY = lastTap.y;
      }
      if (touches.size === 1 && !gesture.tapAndDrag) {
        longPressTimer = setTimer(onLongPress, LONG_PRESS_MS);
      }
      return;
    }
    if (gesture.kind === "pending") {
      cancelLongPress();
      gesture.maxFingers = Math.max(gesture.maxFingers, touches.size);
      gesture.tapAndDrag = false;
      // Multi-finger taps act at the fingers' centre.
      gesture.startX = c.x;
      gesture.startY = c.y;
    }
    rebaseline();
  }

  function touchMove(changed) {
    for (const t of changed) {
      const known = touches.get(t.id);
      if (known) {
        known.x = t.x;
        known.y = t.y;
      }
    }
    if (!gesture) return;
    const c = centroid();
    if (gesture.kind === "pending") {
      if (gesture.maxFingers === 1) {
        if (Math.hypot(c.x - gesture.startX, c.y - gesture.startY) <= TAP_SLOP) return;
        cancelLongPress();
        if (gesture.tapAndDrag) {
          beginDrag();
        } else if (mode === "trackpad") {
          gesture.kind = "move";
        } else if (actions.canPan()) {
          gesture.kind = "pan";
        } else {
          gesture.kind = "hover";
        }
        moveSingle(c);
        return;
      }
      if (touches.size === 2) {
        if (Math.abs(spread() - gesture.lastSpread) > PINCH_SLOP) {
          gesture.kind = "pinch";
          gesture.lastSpread = spread();
          gesture.lastX = c.x;
          gesture.lastY = c.y;
        } else if (Math.hypot(c.x - gesture.lastX, c.y - gesture.lastY) > TAP_SLOP) {
          gesture.kind = "scroll";
          // Remote apps scroll whatever is under the pointer: in touch
          // mode that should be what's under your fingers.
          if (mode === "touch") actions.pointTo(gesture.startX, gesture.startY);
          gesture.lastX = c.x;
          gesture.lastY = c.y;
        }
        return;
      }
      if (Math.hypot(c.x - gesture.lastX, c.y - gesture.lastY) > TAP_SLOP) {
        gesture.kind = "ignored"; // three-finger drags do nothing
      }
      return;
    }
    if (gesture.kind === "held") {
      if (Math.hypot(c.x - gesture.startX, c.y - gesture.startY) <= TAP_SLOP) return;
      beginDrag();
      moveSingle(c);
      return;
    }
    if (gesture.kind === "pinch" || gesture.kind === "scroll") {
      if (touches.size >= 2) moveMulti(c);
      return;
    }
    if (touches.size === 1) moveSingle(c);
  }

  function touchEnd(changed) {
    for (const t of changed) touches.delete(t.id);
    if (!gesture) return;
    if (touches.size > 0) {
      rebaseline();
      return;
    }
    cancelLongPress();
    const g = gesture;
    gesture = null;
    const t = now();
    switch (g.kind) {
      case "pending":
        if (g.maxFingers === 1) {
          if (mode === "touch") actions.pointTo(g.startX, g.startY);
          actions.button(BUTTON_LEFT, true);
          actions.button(BUTTON_LEFT, false);
          lastTap = { time: t, x: g.startX, y: g.startY };
          return;
        }
        if (t - g.startTime <= MULTI_TAP_MAX_MS) {
          const button = g.maxFingers === 2 ? BUTTON_RIGHT : BUTTON_MIDDLE;
          if (mode === "touch") actions.pointTo(g.startX, g.startY);
          actions.button(button, true);
          actions.button(button, false);
        }
        break;
      case "held":
        actions.button(BUTTON_RIGHT, true);
        actions.button(BUTTON_RIGHT, false);
        break;
      case "drag":
        actions.button(BUTTON_LEFT, false);
        break;
    }
    lastTap = null;
  }

  function touchCancel() {
    cancelLongPress();
    if (gesture && gesture.kind === "drag") actions.button(BUTTON_LEFT, false);
    gesture = null;
    touches.clear();
    lastTap = null;
  }

  return {
    get mode() {
      return mode;
    },
    setMode(next) {
      mode = next === "trackpad" ? "trackpad" : "touch";
      touchCancel();
    },
    touchStart,
    touchMove,
    touchEnd,
    touchCancel,
  };
}

/* ----- Text entry ----- */

const SPECIAL_KEYSYMS = {
  "\n": 0xff0d, // Return
  "\r": 0xff0d,
  "\t": 0xff09, // Tab
  "\b": 0xff08, // BackSpace
};

/**
 * X11 keysym for one character, or null for characters that can't be
 * typed. Latin-1 maps directly; everything else uses the Unicode keysym
 * range (0x01000000 + code point), which VNC servers understand.
 */
export function keysymForChar(ch) {
  if (SPECIAL_KEYSYMS[ch] !== undefined) return SPECIAL_KEYSYMS[ch];
  const cp = ch.codePointAt(0);
  if (cp === undefined || cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return null;
  if (cp < 0x100) return cp;
  return 0x01000000 | cp;
}

/** Keysyms for a string, skipping untypeable characters. "\r\n" is one Return. */
export function keysymsForText(text) {
  const out = [];
  const normalized = String(text).replace(/\r\n/g, "\n");
  for (const ch of normalized) {
    const keysym = keysymForChar(ch);
    if (keysym !== null) out.push(keysym);
  }
  return out;
}
