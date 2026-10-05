import { describe, expect, it } from "vitest";
import {
  DISPLAY_REGIONS,
  fitZoomForRegion,
  isDisplayRegion,
  regionLabel,
  regionRect,
} from "./displayRegion";

describe("regionRect", () => {
  const fb = { width: 3840, height: 1080 };
  it("full covers the framebuffer", () => {
    expect(regionRect(fb, "full")).toEqual({ x: 0, y: 0, w: 3840, h: 1080 });
  });
  it("left/right split horizontally", () => {
    expect(regionRect(fb, "left")).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(regionRect(fb, "right")).toEqual({ x: 1920, y: 0, w: 1920, h: 1080 });
  });
  it("top/bottom split vertically", () => {
    expect(regionRect(fb, "top")).toEqual({ x: 0, y: 0, w: 3840, h: 540 });
    expect(regionRect(fb, "bottom")).toEqual({ x: 0, y: 540, w: 3840, h: 540 });
  });
});

describe("fitZoomForRegion", () => {
  it("fits a half into a phone viewport", () => {
    const zoom = fitZoomForRegion(
      { width: 800, height: 1200 },
      { x: 0, y: 0, w: 1920, h: 1080 },
    );
    expect(zoom).toBeCloseTo(800 / 1920, 5);
  });
  it("clamps to 25–400%", () => {
    expect(fitZoomForRegion({ width: 10000, height: 10000 }, { x: 0, y: 0, w: 10, h: 10 })).toBe(4);
    expect(fitZoomForRegion({ width: 10, height: 10 }, { x: 0, y: 0, w: 10000, h: 10000 })).toBe(0.25);
  });
  it("returns 1 for degenerate input", () => {
    expect(fitZoomForRegion({ width: 0, height: 0 }, { x: 0, y: 0, w: 100, h: 100 })).toBe(1);
  });
});

describe("regionLabel / isDisplayRegion", () => {
  it("labels every region", () => {
    for (const r of DISPLAY_REGIONS) {
      expect(regionLabel(r)).toMatch(/./);
    }
  });
  it("validates region values", () => {
    expect(isDisplayRegion("left")).toBe(true);
    expect(isDisplayRegion("diagonal")).toBe(false);
    expect(isDisplayRegion(undefined)).toBe(false);
  });
});
