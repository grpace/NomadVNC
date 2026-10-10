import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { VIEWER_IFRAME_CSP, createViewerHtml, describeStall } from "./index";

const BOOTSTRAP_URL = "app://nomadvnc/vendor/viewer-bootstrap.mjs";

function baseConfig() {
  return {
    wsUrl: "ws://127.0.0.1:49001",
    password: "<redacted>",
    bootstrapModuleUrl: "app://nomadvnc/vendor/novnc/core/rfb.js",
    bootstrapScriptUrl: BOOTSTRAP_URL,
    desktop: true,
  } as const;
}

describe("createViewerHtml", () => {
  it("uses a caller-provided noVNC module URL inside the JSON config block", () => {
    const html = createViewerHtml({
      ...baseConfig(),
      bootstrapModuleUrl: "app://nomadvnc/vendor/novnc/core/rfb.js",
      fitToScreen: true,
    });

    expect(html).toContain('id="viewer-config"');
    expect(html).toContain('"bootstrapModuleUrl":"app://nomadvnc/vendor/novnc/core/rfb.js"');
    expect(html).not.toContain("https://esm.sh/@novnc/novnc/core/rfb?bundle");
  });

  it("loads the viewer bootstrap as an external module script, never inline", () => {
    const html = createViewerHtml(baseConfig());

    // The only executable script is the external bootstrap module; the
    // per-session config rides in a non-executable JSON data block. An inline
    // bootstrap would be refused by the Electron renderer's CSP (no
    // 'unsafe-inline'), which also applies to srcdoc iframes.
    expect(html).toContain(
      `<script type="module" src="${BOOTSTRAP_URL}"></script>`,
    );
    expect(html).toContain('<script type="application/json" id="viewer-config">');
    expect(html).not.toMatch(/<script(?![^>]*type="application\/json")(?![^>]*src=)[^>]*>/);
  });

  it("includes VNC username in the JSON config for macOS ARD", () => {
    const html = createViewerHtml({
      ...baseConfig(),
      username: "macuser",
      bootstrapModuleUrl: "app://nomadvnc/vendor/novnc/core/rfb.js",
      fitToScreen: true,
    });

    expect(html).toContain('"username":"macuser"');
  });

  it("escapes unsafe payload characters and never references a remote CDN", () => {
    const html = createViewerHtml({
      wsUrl: "ws://127.0.0.1:49001",
      password: "hunter2<secret>",
      bootstrapModuleUrl: "http://127.0.0.1:49002/viewer-runtime.js",
      bootstrapScriptUrl: BOOTSTRAP_URL,
      desktop: false,
    });

    expect(html).not.toContain("esm.sh");
    expect(VIEWER_IFRAME_CSP).not.toContain("https:");
    expect(html).toContain("\\u003csecret>");
    expect(html).toContain("color-scheme: light dark;");
  });

  it("HTML-attribute-escapes the bootstrap script URL", () => {
    const html = createViewerHtml({
      ...baseConfig(),
      bootstrapScriptUrl: "https://example.com/boot.js?x=1&y=\"2\"",
    });

    expect(html).toContain(
      '<script type="module" src="https://example.com/boot.js?x=1&amp;y=&quot;2&quot;"></script>',
    );
    expect(html).not.toContain('y="2"');
  });

  it("embeds a locked-down CSP in the iframe document", () => {
    const html = createViewerHtml(baseConfig());

    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain(VIEWER_IFRAME_CSP);
    expect(VIEWER_IFRAME_CSP).toContain("default-src 'none'");
    expect(VIEWER_IFRAME_CSP).toContain("ws://127.0.0.1:*");
    expect(VIEWER_IFRAME_CSP).toContain("object-src 'none'");
  });

  it("forbids inline scripts: the bootstrap must load as an external module", () => {
    // The executable bootstrap moved out of the HTML into an external module
    // (Electron's parent CSP has no 'unsafe-inline' and governs srcdoc
    // iframes too), so the iframe policy must not re-allow inline execution.
    const scriptSrc = VIEWER_IFRAME_CSP.split(";").find((d) =>
      d.trim().startsWith("script-src"),
    );
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).toContain("'self'");
  });

  it("omits frame-ancestors: ignored in meta-delivered policies, warns in console", () => {
    // This policy ships via <meta http-equiv>, where `frame-ancestors` is
    // ignored per spec and Chromium logs a console warning for it.
    expect(VIEWER_IFRAME_CSP).not.toContain("frame-ancestors");
  });
});

describe("bootstrap.mjs", () => {
  const bootstrap = readFileSync(new URL("./bootstrap.mjs", import.meta.url), "utf8");

  it("carries the viewer logic that used to be inline", () => {
    for (const marker of [
      "buildInitialCredentials",
      "noteViewerInput",
      "new RFB(",
      'notifyParent({ type: "viewerReady" })',
      'setTimeout(() => notifyParent({ type: "viewerIdle" }), 1500)',
    ]) {
      expect(bootstrap).toContain(marker);
    }
  });

  it("zooms with noVNC's display viewport, never CSS transforms (keeps clicks accurate)", () => {
    expect(bootstrap).toContain("rfb._updateScale = () => applyView();");
    expect(bootstrap).toContain("d.viewportChangeSize(vw, vh);");
    expect(bootstrap).not.toMatch(/style\.transform\s*=/);
  });

  it("reports the remote resolution itself (noVNC has no desktopsize event)", () => {
    expect(bootstrap).not.toContain('"desktopsize"');
    expect(bootstrap).toContain('notifyParent({ type: "viewerResize", width: fbW, height: fbH });');
  });

  it("routes touches through the input module and types text with it", () => {
    expect(bootstrap).toContain("input.createTouchController(");
    expect(bootstrap).toContain('viewer.addEventListener(type, onTouch, { capture: true, passive: false });');
    expect(bootstrap).toContain("input.keysymsForText(cmd.text)");
  });

  it("reports a rejected password as authFailed instead of a dropped connection", () => {
    expect(bootstrap).toContain('rfb.addEventListener("securityfailure"');
    expect(bootstrap).toContain('state: "authFailed"');
    expect(bootstrap).toContain("if (authFailed) return;");
  });

  it("only accepts commands from the embedding parent or a same-document event", () => {
    expect(bootstrap).toContain("if (event.source !== null && event.source !== window.parent) return;");
  });

  it("reads per-session config from the JSON block and imports noVNC dynamically", () => {
    expect(bootstrap).toContain('document.getElementById("viewer-config")');
    expect(bootstrap).toContain("await import(config.bootstrapModuleUrl)");
    expect(bootstrap).not.toContain("${");
  });
});

describe("describeStall", () => {
  it("blames the local network first when offline", () => {
    expect(describeStall("Lab", { found: true, latencyMs: 20 }, false)).toMatch(/offline/);
  });

  it("says the network is fine when the peer answers a ping", () => {
    expect(describeStall("Lab", { found: true, latencyMs: 42 })).toBe(
      "The network reaches Lab (42 ms), but its VNC server isn't answering. The computer may be busy or asleep.",
    );
  });

  it("points at the path or the computer when the ping goes unanswered", () => {
    expect(describeStall("Lab", { found: true })).toMatch(/isn't answering over the tailnet/);
    expect(describeStall("Lab", { found: false })).toMatch(/isn't on the tailnet/);
  });

  it("stays generic without a tailnet sample", () => {
    expect(describeStall("Lab", null)).toMatch(/hasn't answered/);
    expect(describeStall("Lab", undefined)).toMatch(/Checking/);
  });
});
