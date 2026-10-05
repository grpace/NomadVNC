import { describe, expect, it } from "vitest";
import { isAppNavigation, isSafeExternalUrl } from "./navigation";

describe("isSafeExternalUrl", () => {
  it("allows web links only", () => {
    expect(isSafeExternalUrl("https://login.tailscale.com/a/abc")).toBe(true);
    expect(isSafeExternalUrl("http://example.test")).toBe(true);
    expect(isSafeExternalUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeExternalUrl("smb://evil.example/share")).toBe(false);
    expect(isSafeExternalUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeExternalUrl("not a url")).toBe(false);
  });
});

describe("isAppNavigation", () => {
  const packaged = "file:///opt/NomadVNC/resources/app.asar/dist-electron/renderer/index.html";

  it("keeps the packaged entry document (incl. hash/query) in-app", () => {
    expect(isAppNavigation(`${packaged}#settings`, packaged)).toBe(true);
    expect(isAppNavigation(`${packaged}?x=1`, packaged)).toBe(true);
  });

  it("treats other files and remote pages as navigation away", () => {
    expect(isAppNavigation("file:///home/user/evil.html", packaged)).toBe(false);
    expect(isAppNavigation("https://evil.example/", packaged)).toBe(false);
  });

  it("allows the dev server origin only", () => {
    const dev = "http://127.0.0.1:5173";
    expect(isAppNavigation("http://127.0.0.1:5173/?reload", dev)).toBe(true);
    expect(isAppNavigation("http://127.0.0.1:9999/", dev)).toBe(false);
  });
});
