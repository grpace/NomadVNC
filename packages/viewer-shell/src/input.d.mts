/** Types for `input.mjs` (plain JS so the viewer can load it without a build). */

export type PointerMode = "touch" | "trackpad";

export interface TouchPoint {
  id: number;
  x: number;
  y: number;
}

export interface TouchActions {
  /** Touch mode: move the remote pointer to this client point. */
  pointTo(x: number, y: number): void;
  /** Trackpad mode: move the remote pointer by this many client pixels. */
  moveBy(dx: number, dy: number): void;
  /** Press or release a button at the current pointer (0 left, 1 middle, 2 right). */
  button(button: number, down: boolean): void;
  /** Wheel steps at the current pointer; positive = down / right. */
  scroll(stepsX: number, stepsY: number): void;
  /** Zoom the local view by `factor` around a client point. */
  zoom(factor: number, x: number, y: number): void;
  /** Move the local view's content by client pixels. */
  pan(dx: number, dy: number): void;
  /** Whether the view is zoomed in past the screen (one-finger drag pans). */
  canPan(): boolean;
  /** A long press registered (for haptic feedback). */
  longPress?(): void;
}

export interface TouchController {
  readonly mode: PointerMode;
  setMode(mode: PointerMode): void;
  touchStart(changed: TouchPoint[]): void;
  touchMove(changed: TouchPoint[]): void;
  touchEnd(changed: TouchPoint[]): void;
  touchCancel(): void;
}

export const TAP_SLOP: number;
export const LONG_PRESS_MS: number;
export const DOUBLE_TAP_MS: number;
export const DOUBLE_TAP_SLOP: Record<PointerMode, number>;
export const MULTI_TAP_MAX_MS: number;
export const PINCH_SLOP: number;
export const SCROLL_STEP: number;
export const BUTTON_LEFT: 0;
export const BUTTON_MIDDLE: 1;
export const BUTTON_RIGHT: 2;

export function trackpadGain(distancePx: number, elapsedMs: number): number;

export function createTouchController(options: {
  mode?: PointerMode;
  actions: TouchActions;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}): TouchController;

export function keysymForChar(ch: string): number | null;
export function keysymsForText(text: string): number[];
