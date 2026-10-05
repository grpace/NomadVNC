// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import {
  AUTH_CALLBACK_SCHEME,
  extractAuthCallbackToken,
  findAuthCallbackUrl,
  registerAuthCallbackProtocol,
  watchAuthCallbackUrls,
  type DeepLinkApp,
} from "./deepLink";

describe("extractAuthCallbackToken", () => {
  it("extracts the token from the canonical deep link", () => {
    expect(extractAuthCallbackToken(`${AUTH_CALLBACK_SCHEME}://auth/callback?token=abc123`)).toBe("abc123");
  });

  it("accepts the triple-slash and bare-colon spellings", () => {
    expect(extractAuthCallbackToken(`${AUTH_CALLBACK_SCHEME}:///auth/callback?token=t1`)).toBe("t1");
    expect(extractAuthCallbackToken(`${AUTH_CALLBACK_SCHEME}:auth/callback?token=t2`)).toBe("t2");
  });

  it("decodes URL-encoded tokens", () => {
    expect(extractAuthCallbackToken(`${AUTH_CALLBACK_SCHEME}://auth/callback?token=a%20b`)).toBe("a b");
  });

  it("rejects other schemes", () => {
    expect(extractAuthCallbackToken("https://example.com/auth/callback?token=abc")).toBeNull();
    expect(extractAuthCallbackToken("other://auth/callback?token=abc")).toBeNull();
  });

  it("rejects the wrong path", () => {
    expect(extractAuthCallbackToken(`${AUTH_CALLBACK_SCHEME}://other/path?token=abc`)).toBeNull();
    expect(extractAuthCallbackToken(`${AUTH_CALLBACK_SCHEME}://auth?token=abc`)).toBeNull();
  });

  it("rejects missing or blank tokens", () => {
    expect(extractAuthCallbackToken(`${AUTH_CALLBACK_SCHEME}://auth/callback`)).toBeNull();
    expect(extractAuthCallbackToken(`${AUTH_CALLBACK_SCHEME}://auth/callback?token=`)).toBeNull();
    expect(extractAuthCallbackToken(`${AUTH_CALLBACK_SCHEME}://auth/callback?token=%20`)).toBeNull();
  });

  it("rejects raw tokens and garbage", () => {
    expect(extractAuthCallbackToken("abc123")).toBeNull();
    expect(extractAuthCallbackToken("")).toBeNull();
    expect(extractAuthCallbackToken(`${AUTH_CALLBACK_SCHEME}://%`)).toBeNull();
  });
});

describe("findAuthCallbackUrl", () => {
  it("finds the deep link among other argv entries", () => {
    const url = `${AUTH_CALLBACK_SCHEME}://auth/callback?token=xyz`;
    expect(findAuthCallbackUrl(["/usr/bin/app", "--flag", url])).toBe(url);
  });

  it("matches case-insensitively and trims whitespace", () => {
    expect(findAuthCallbackUrl(["NOMADVNC://auth/callback?token=a "])).toBe("NOMADVNC://auth/callback?token=a");
  });

  it("returns null when no deep link is present", () => {
    expect(findAuthCallbackUrl(["/usr/bin/app", "--flag"])).toBeNull();
    expect(findAuthCallbackUrl([])).toBeNull();
  });
});

interface FakeApp extends DeepLinkApp {
  protocolCalls: { protocol: string; path?: string; args?: readonly string[] }[];
  listeners: Map<string, (...args: never[]) => void>;
}

function createFakeApp(): FakeApp {
  return {
    protocolCalls: [],
    listeners: new Map(),
    setAsDefaultProtocolClient(protocol: string, path?: string, args?: readonly string[]) {
      this.protocolCalls.push({ protocol, path, args });
      return true;
    },
    on(event: string, listener: (...args: never[]) => void) {
      this.listeners.set(event, listener);
      return this;
    },
  };
}

describe("registerAuthCallbackProtocol", () => {
  it("registers the electron binary plus main entry in dev", () => {
    const app = createFakeApp();
    registerAuthCallbackProtocol(app, {
      execPath: "/usr/bin/electron",
      mainEntry: "/app/dist-electron/main/main.js",
      isDefaultApp: true,
    });
    expect(app.protocolCalls).toEqual([
      {
        protocol: AUTH_CALLBACK_SCHEME,
        path: "/usr/bin/electron",
        args: ["/app/dist-electron/main/main.js"],
      },
    ]);
  });

  it("registers the app bundle itself when packaged", () => {
    const app = createFakeApp();
    registerAuthCallbackProtocol(app, { execPath: "/usr/bin/app", mainEntry: "", isDefaultApp: false });
    expect(app.protocolCalls).toEqual([{ protocol: AUTH_CALLBACK_SCHEME, path: undefined, args: undefined }]);
  });
});

describe("watchAuthCallbackUrls", () => {
  it("forwards macOS open-url and prevents the default", () => {
    const app = createFakeApp();
    const onUrl = vi.fn();
    const preventDefault = vi.fn();
    watchAuthCallbackUrls(app, onUrl);
    const url = `${AUTH_CALLBACK_SCHEME}://auth/callback?token=mac`;
    app.listeners.get("open-url")?.({ preventDefault } as never, url as never);
    expect(preventDefault).toHaveBeenCalled();
    expect(onUrl).toHaveBeenCalledWith(url);
  });

  it("forwards second-instance argv carrying a deep link", () => {
    const app = createFakeApp();
    const onUrl = vi.fn();
    watchAuthCallbackUrls(app, onUrl);
    const url = `${AUTH_CALLBACK_SCHEME}://auth/callback?token=second`;
    app.listeners.get("second-instance")?.(undefined as never, ["/usr/bin/app", url] as never, "" as never);
    expect(onUrl).toHaveBeenCalledWith(url);
  });

  it("ignores second-instance launches without a deep link", () => {
    const app = createFakeApp();
    const onUrl = vi.fn();
    watchAuthCallbackUrls(app, onUrl);
    app.listeners.get("second-instance")?.(undefined as never, ["/usr/bin/app"] as never, "" as never);
    expect(onUrl).not.toHaveBeenCalled();
  });
});
