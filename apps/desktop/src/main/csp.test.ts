import { describe, expect, it } from "vitest";
import {
  DEVELOPMENT_RENDERER_CSP,
  PRODUCTION_RENDERER_CSP,
  getMetaCsp,
  getRendererCsp,
} from "./csp";

describe("renderer CSP", () => {
  it("selects the production policy for packaged builds", () => {
    expect(getRendererCsp(true)).toBe(PRODUCTION_RENDERER_CSP);
  });

  it("selects the development policy for dev builds", () => {
    expect(getRendererCsp(false)).toBe(DEVELOPMENT_RENDERER_CSP);
  });

  it("keeps production scripts local-only", () => {
    expect(PRODUCTION_RENDERER_CSP).toContain("script-src 'self' file:");
    expect(PRODUCTION_RENDERER_CSP).not.toContain("unsafe-eval");
    expect(PRODUCTION_RENDERER_CSP).not.toContain("https://esm.sh");
    expect(PRODUCTION_RENDERER_CSP).toContain("object-src 'none'");
  });

  it("has no remote CDN origins (fonts are bundled locally)", () => {
    for (const policy of [PRODUCTION_RENDERER_CSP, DEVELOPMENT_RENDERER_CSP]) {
      expect(policy).not.toContain("fonts.googleapis.com");
      expect(policy).not.toContain("fonts.gstatic.com");
    }
  });

  it("keeps the loopback sidecar proxy reachable in both policies", () => {
    for (const policy of [PRODUCTION_RENDERER_CSP, DEVELOPMENT_RENDERER_CSP]) {
      expect(policy).toContain("ws://127.0.0.1:*");
      expect(policy).toContain("connect-src");
    }
  });

  it("allows the Vite dev server only in development", () => {
    expect(DEVELOPMENT_RENDERER_CSP).toContain("http://127.0.0.1:5173");
    expect(PRODUCTION_RENDERER_CSP).not.toContain("http://127.0.0.1:5173");
  });

  it("strips frame-ancestors from the meta-delivered CSP (ignored there, warns in console)", () => {
    for (const packaged of [true, false]) {
      const meta = getMetaCsp(packaged);
      expect(meta).not.toContain("frame-ancestors");
      // every other directive survives the strip
      for (const directive of getRendererCsp(packaged)
        .split(";")
        .map((d) => d.trim())
        .filter((d) => d.length > 0 && !d.startsWith("frame-ancestors"))) {
        expect(meta).toContain(directive);
      }
    }
  });

  it("keeps frame-ancestors in the header-delivered CSP (still enforced)", () => {
    expect(PRODUCTION_RENDERER_CSP).toContain("frame-ancestors 'self' file:");
    expect(DEVELOPMENT_RENDERER_CSP).toContain("frame-ancestors");
  });
});
