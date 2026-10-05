import { describe, expect, it } from "vitest";
import { buildMobileViewerHtml } from "./viewerHtml";

describe("buildMobileViewerHtml", () => {
  const html = buildMobileViewerHtml({
    wsUrl: "ws://127.0.0.1:54321/vnc?token=abc",
    password: "s3cret",
    assetBaseUrl: "http://127.0.0.1:45678/",
  });

  it("loads the bootstrap from the native asset server", () => {
    expect(html).toContain('src="http://127.0.0.1:45678/viewer-bootstrap.mjs"');
    expect(html).toContain("http://127.0.0.1:45678/viewer-runtime.js");
  });

  it("fits the remote desktop centered in the phone", () => {
    expect(html).not.toContain("fitAlign");
    expect(html).toContain('id="viewer"');
    expect(html).not.toContain("align-start");
  });

  it("loads the touch/typing module and defaults to touch mode", () => {
    expect(html).toContain('"inputModuleUrl":"http://127.0.0.1:45678/viewer-input.mjs"');
    expect(html).toContain('"pointerMode":"touch"');
    const trackpad = buildMobileViewerHtml({
      wsUrl: "ws://127.0.0.1:1/x",
      password: "p",
      assetBaseUrl: "http://127.0.0.1:9",
      pointerMode: "trackpad",
    });
    expect(trackpad).toContain('"pointerMode":"trackpad"');
  });

  it("does not reference the old nomadvnc:// scheme", () => {
    expect(html).not.toContain("nomadvnc://");
  });

  it("embeds the session config as JSON", () => {
    expect(html).toContain("ws://127.0.0.1:54321/vnc?token=abc");
  });

  it("keeps scripts free of unsafe-inline (style-src may keep it)", () => {
    expect(html).toContain("Content-Security-Policy");
    const scriptSrc = html.match(/script-src[^;"]*/)![0];
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it("normalizes a missing trailing slash on the base URL", () => {
    const noSlash = buildMobileViewerHtml({
      wsUrl: "ws://127.0.0.1:1/x",
      password: "p",
      assetBaseUrl: "http://127.0.0.1:9",
    });
    expect(noSlash).toContain("http://127.0.0.1:9/viewer-bootstrap.mjs");
  });
});
