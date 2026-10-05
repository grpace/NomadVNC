import { describe, expect, it } from "vitest";
import {
  fitZoomForRegion,
  regionLabel,
  regionRect,
} from "./displayRegion";

describe("regionRect", () => {
  it("splits wide framebuffers into halves", () => {
    const fb = { width: 3840, height: 1080 };
    expect(regionRect(fb, "left")).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(regionRect(fb, "right")).toEqual({ x: 1920, y: 0, w: 1920, h: 1080 });
    expect(regionRect(fb, "full")).toEqual({ x: 0, y: 0, w: 3840, h: 1080 });
  });

  it("splits tall framebuffers into halves", () => {
    const fb = { width: 1920, height: 2160 };
    expect(regionRect(fb, "top")).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
    expect(regionRect(fb, "bottom")).toEqual({ x: 0, y: 1080, w: 1920, h: 1080 });
  });
});

describe("fitZoomForRegion", () => {
  it("fits the region into the viewport", () => {
    // Half of a 3840x1080 span on a 1920x1080 window ≈ 1:1.
    expect(fitZoomForRegion({ width: 1920, height: 1080 }, { x: 0, y: 0, w: 1920, h: 1080 })).toBeCloseTo(1);
    // Same half on a small 1280x720 window scales down.
    expect(fitZoomForRegion({ width: 1280, height: 720 }, { x: 0, y: 0, w: 1920, h: 1080 })).toBeCloseTo(1280 / 1920);
  });

  it("clamps to 25-400% and falls back without sizes", () => {
    expect(fitZoomForRegion({ width: 8000, height: 8000 }, { x: 0, y: 0, w: 100, h: 100 })).toBe(4);
    expect(fitZoomForRegion({ width: 100, height: 100 }, { x: 0, y: 0, w: 8000, h: 8000 })).toBe(0.25);
    expect(fitZoomForRegion({ width: 0, height: 0 }, { x: 0, y: 0, w: 1920, h: 1080 })).toBe(1);
  });

  it("labels regions for the picker", () => {
    expect(regionLabel("left")).toBe("Left Half");
    expect(regionLabel("full")).toBe("Full Display");
  });
});
