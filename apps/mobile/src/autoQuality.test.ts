import { describe, expect, it } from "vitest";
import type { PeerPathInfo } from "@nomadvnc/platform-contracts";
import { qualityLabelFor, suggestAutoQuality } from "./autoQuality";

function path(overrides: Partial<PeerPathInfo> = {}): PeerPathInfo {
  return {
    host: "lab.tail.ts.net",
    found: true,
    path: "direct",
    ...overrides,
  };
}

describe("suggestAutoQuality", () => {
  it("leaves the manual setting alone without data", () => {
    expect(suggestAutoQuality(undefined, 8)).toBeNull();
    expect(suggestAutoQuality(null, 8)).toBeNull();
    expect(suggestAutoQuality(path({ path: "unknown" }), 8)).toBeNull();
  });

  it("respects fast direct paths", () => {
    expect(suggestAutoQuality(path({ latencyMs: 32 }), 8)).toBeNull();
    expect(suggestAutoQuality(path({}), 8)).toBeNull();
  });

  it("degrades slow direct paths to medium", () => {
    expect(suggestAutoQuality(path({ latencyMs: 150 }), 8)).toBe(5);
  });

  it("degrades relayed paths by latency", () => {
    expect(suggestAutoQuality(path({ path: "relay", latencyMs: 300 }), 8)).toBe(2);
    expect(suggestAutoQuality(path({ path: "relay", latencyMs: 150 }), 8)).toBe(5);
    expect(suggestAutoQuality(path({ path: "relay" }), 8)).toBe(5);
  });

  it("drops to low when the host has no path", () => {
    expect(suggestAutoQuality(path({ found: false, path: "unknown" }), 8)).toBe(2);
  });

  it("never exceeds the manual ceiling", () => {
    expect(suggestAutoQuality(path({ path: "relay", latencyMs: 300 }), 2)).toBe(2);
    expect(suggestAutoQuality(path({ latencyMs: 150 }), 5)).toBe(5);
  });

  it("labels effective quality values", () => {
    expect(qualityLabelFor(2)).toBe("Low");
    expect(qualityLabelFor(9)).toBe("Lossless");
    expect(qualityLabelFor(3)).toBe("Custom");
  });
});
