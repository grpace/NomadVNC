/**
 * Display-region selection for the mobile viewer (desktop parity:
 * apps/desktop/src/renderer/displayRegion.ts).
 *
 * Multi-monitor VNC servers present as one wide framebuffer. Selecting a
 * region zooms the viewer to fit that half of the framebuffer — the fix
 * for a dual-monitor strip squashed unreadably small on a phone screen.
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

export function isDisplayRegion(value: unknown): value is DisplayRegion {
  return DISPLAY_REGIONS.includes(value as DisplayRegion);
}
