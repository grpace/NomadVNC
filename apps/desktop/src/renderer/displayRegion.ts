/**
 * Multi-monitor views over a spanning VNC framebuffer.
 *
 * Base VNC remotes every monitor as one wide framebuffer and noVNC exposes
 * no per-monitor API, so true per-display isolation is impossible
 * client-side. What *is* possible — and fixes the real complaint (a
 * dual-monitor strip squashed unreadably small) — is viewing one half of
 * the framebuffer at fit-to-window zoom and scrolling between halves.
 * These pure helpers compute the region rect + fit zoom; the panel turns
 * them into `setScaleMode` zoom commands plus surface scrolling.
 */

export type DisplayRegion = "full" | "left" | "right" | "top" | "bottom";

export const DISPLAY_REGIONS: DisplayRegion[] = ["full", "left", "right", "top", "bottom"];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Size {
  width: number;
  height: number;
}

export function regionRect(fb: Size, region: DisplayRegion): Rect {
  switch (region) {
    case "left":
      return { x: 0, y: 0, w: fb.width / 2, h: fb.height };
    case "right":
      return { x: fb.width / 2, y: 0, w: fb.width - fb.width / 2, h: fb.height };
    case "top":
      return { x: 0, y: 0, w: fb.width, h: fb.height / 2 };
    case "bottom":
      return { x: 0, y: fb.height / 2, w: fb.width, h: fb.height - fb.height / 2 };
    case "full":
      return { x: 0, y: 0, w: fb.width, h: fb.height };
  }
}

/** Largest zoom that fits the region into the viewport, clamped to 25–400%. */
export function fitZoomForRegion(viewport: Size, rect: Rect): number {
  if (viewport.width <= 0 || viewport.height <= 0 || rect.w <= 0 || rect.h <= 0) {
    return 1;
  }
  const zoom = Math.min(viewport.width / rect.w, viewport.height / rect.h);
  return Math.min(4, Math.max(0.25, zoom));
}

export function regionLabel(region: DisplayRegion): string {
  switch (region) {
    case "full":
      return "Full Display";
    case "left":
      return "Left Half";
    case "right":
      return "Right Half";
    case "top":
      return "Top Half";
    case "bottom":
      return "Bottom Half";
  }
}
