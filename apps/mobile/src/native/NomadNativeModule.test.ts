import { beforeEach, describe, expect, it, vi } from "vitest";

const removeListener = vi.fn();
const nativeMocks = vi.hoisted(() => ({
  ensureTailnetReady: vi.fn(),
  getTailnetPeers: vi.fn(),
  getTailnetState: vi.fn(),
  getPeerPath: vi.fn(),
  startVncSession: vi.fn(),
  stopVncSession: vi.fn(),
  logoutTailnet: vi.fn(),
  reauthenticateTailnet: vi.fn(),
  resetTailnetIdentity: vi.fn(),
  getSecureItem: vi.fn(),
  setSecureItem: vi.fn(),
  deleteSecureItem: vi.fn(),
  getSecureStorageStatus: vi.fn(),
  readClipboard: vi.fn(),
  writeClipboard: vi.fn(),
  getClipboardChangeToken: vi.fn(),
  getAppVersion: vi.fn(),
  getViewerAssetBaseUrl: vi.fn(),
  addListener: vi.fn(),
}));

vi.mock("react-native", () => ({
  NativeModules: { NomadNativeModule: nativeMocks },
  NativeEventEmitter: class {
    addListener = (...args: unknown[]) => {
      nativeMocks.addListener(...args);
      return { remove: removeListener };
    };
  },
  Platform: { OS: "ios" },
}));

// Import after the mock is registered.
const { NomadNativeModule } = await import("./NomadNativeModule");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("bridge translation", () => {
  it("parses JSON results from ensureTailnetReady", async () => {
    nativeMocks.ensureTailnetReady.mockResolvedValue(
      JSON.stringify({ loggedIn: true, inMapPoll: true, selfDeviceName: "pixel" }),
    );
    const state = await NomadNativeModule.ensureTailnetReady();
    expect(state.loggedIn).toBe(true);
    expect(state.selfDeviceName).toBe("pixel");
  });

  it("lets native rejections propagate with their message", async () => {
    nativeMocks.ensureTailnetReady.mockRejectedValue(new Error("tailscaled not running"));
    await expect(NomadNativeModule.ensureTailnetReady()).rejects.toThrow(/tailscaled not running/);
  });

  it("passes host/port/token/direct through to startVncSession", async () => {
    nativeMocks.startVncSession.mockResolvedValue(
      JSON.stringify({ sessionId: "s1", wsUrl: "ws://x/vnc", status: "starting" }),
    );
    const info = await NomadNativeModule.startVncSession({
      host: "192.168.1.2",
      port: 5900,
      sessionToken: "t",
      direct: true,
    });
    expect(nativeMocks.startVncSession).toHaveBeenCalledWith("192.168.1.2", 5900, "t", true);
    expect(info.sessionId).toBe("s1");
  });

  it("stops sessions by id", async () => {
    nativeMocks.stopVncSession.mockResolvedValue(undefined);
    await NomadNativeModule.stopVncSession("s1");
    expect(nativeMocks.stopVncSession).toHaveBeenCalledWith("s1");
  });

  it("reads the secure storage status JSON", async () => {
    nativeMocks.getSecureStorageStatus.mockResolvedValue(
      JSON.stringify({ available: true, platform: "ios", backend: "keychain" }),
    );
    await expect(NomadNativeModule.getSecureStorageStatus()).resolves.toEqual({
      available: true,
      platform: "ios",
      backend: "keychain",
    });
    await expect(NomadNativeModule.canUseSecureStorage()).resolves.toBe(true);
  });

  it("namespaces machine passwords under vnc-password:", async () => {
    nativeMocks.setSecureItem.mockResolvedValue(undefined);
    nativeMocks.getSecureItem.mockResolvedValue("pw");
    await NomadNativeModule.setMachinePassword("m1", "pw");
    expect(nativeMocks.setSecureItem).toHaveBeenCalledWith("vnc-password:m1", "pw");
    await expect(NomadNativeModule.getMachinePassword("m1")).resolves.toBe("pw");
    expect(nativeMocks.getSecureItem).toHaveBeenCalledWith("vnc-password:m1");
  });

  it("stores the account token under account-token", async () => {
    nativeMocks.setSecureItem.mockResolvedValue(undefined);
    await NomadNativeModule.setAccountToken("tok");
    expect(nativeMocks.setSecureItem).toHaveBeenCalledWith("account-token", "tok");
  });

  it("reports the embedded engine as always running", async () => {
    await expect(NomadNativeModule.getSidecarStatus()).resolves.toEqual({ running: true });
  });

  it("normalizes null clipboard reads to an empty string", async () => {
    nativeMocks.readClipboard.mockResolvedValue(null);
    await expect(NomadNativeModule.readClipboard()).resolves.toBe("");
  });

  it("writes clipboard text through", async () => {
    nativeMocks.writeClipboard.mockResolvedValue(undefined);
    await NomadNativeModule.writeClipboard("hello");
    expect(nativeMocks.writeClipboard).toHaveBeenCalledWith("hello");
  });

  it("returns the viewer asset base URL verbatim", async () => {
    nativeMocks.getViewerAssetBaseUrl.mockResolvedValue("http://127.0.0.1:45678/");
    await expect(NomadNativeModule.getViewerAssetBaseUrl()).resolves.toBe("http://127.0.0.1:45678/");
  });

  it("subscribes to NomadNativeEvent and unsubscribes cleanly", () => {
    const listener = vi.fn();
    const unsubscribe = NomadNativeModule.subscribe(listener);
    expect(nativeMocks.addListener).toHaveBeenCalledWith("NomadNativeEvent", listener);
    unsubscribe();
    expect(removeListener).toHaveBeenCalled();
  });
});
