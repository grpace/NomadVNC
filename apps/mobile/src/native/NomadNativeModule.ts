import { NativeEventEmitter, NativeModules } from "react-native";
import type {
  NomadMobilePlatform,
  NomadNativeEvent,
  PeerPathInfo,
  SecureStorageStatus,
  SidecarStatus,
  StartVncSessionInput,
  StartVncSessionResult,
  TailscaleHostnameResult,
} from "@nomadvnc/platform-contracts";
import type { PeerDevice, TailnetState } from "@nomadvnc/domain";

/**
 * Raw React Native bridge to the platform module. Methods exchange JSON
 * strings with the GoMobile engine (see go-core/mobile/mobile.go); secure
 * storage, clipboard, and the viewer asset server are implemented natively
 * (Keychain/Keystore, UIPasteboard/ClipboardManager, loopback HTTP).
 */
interface RawNomadNativeModule {
  ensureTailnetReady(): Promise<string>;
  getTailnetPeers(): Promise<string>;
  getTailnetState(): Promise<string>;
  getPeerPath(host: string): Promise<string>;
  startVncSession(host: string, port: number, token: string, direct: boolean): Promise<string>;
  stopVncSession(sessionId: string): Promise<void>;
  logoutTailnet(): Promise<string>;
  reauthenticateTailnet(): Promise<string>;
  resetTailnetIdentity(): Promise<string>;
  setTailscaleHostname(hostname: string): Promise<string>;
  getSecureItem(key: string): Promise<string | null>;
  setSecureItem(key: string, value: string): Promise<void>;
  deleteSecureItem(key: string): Promise<void>;
  getSecureStorageStatus(): Promise<string>;
  storageGetItem(key: string): Promise<string | null>;
  storageSetItem(key: string, value: string): Promise<void>;
  storageRemoveItem(key: string): Promise<void>;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  getClipboardChangeToken(): Promise<string>;
  getAppVersion(): Promise<string>;
  getViewerAssetBaseUrl(): Promise<string>;
}

function getRawModule(): RawNomadNativeModule {
  const mod = NativeModules.NomadNativeModule as RawNomadNativeModule | undefined;
  if (!mod) {
    throw new Error(
      "NomadNativeModule is not linked. Build and run the native app target " +
        "(see apps/mobile/NATIVE_SETUP.md) — the JS bundle alone cannot reach " +
        "the embedded Go engine.",
    );
  }
  return mod;
}

const PASSWORD_KEY_PREFIX = "vnc-password:";
const ACCOUNT_TOKEN_KEY = "account-token";

async function parseJson<T>(promise: Promise<string>): Promise<T> {
  return JSON.parse(await promise) as T;
}

/** nomadvnc:// URL captured by iOS before JS was listening, or null. */
export async function takePendingAuthURL(): Promise<string | null> {
  const mod = NativeModules.NomadNativeModule as { takePendingAuthURL?: () => Promise<string | null> } | undefined;
  if (!mod?.takePendingAuthURL) {
    return null;
  }
  const url = await mod.takePendingAuthURL();
  return typeof url === "string" && url !== "" ? url : null;
}

export const NomadNativeModule: NomadMobilePlatform = {
  ensureTailnetReady: () => parseJson<TailnetState>(getRawModule().ensureTailnetReady()),
  getTailnetPeers: () => parseJson<PeerDevice[]>(getRawModule().getTailnetPeers()),
  getTailnetState: () => parseJson<TailnetState>(getRawModule().getTailnetState()),
  getPeerPath: (host: string): Promise<PeerPathInfo> =>
    parseJson<PeerPathInfo>(getRawModule().getPeerPath(host)),

  startVncSession: (input: StartVncSessionInput): Promise<StartVncSessionResult> =>
    parseJson<StartVncSessionResult>(
      getRawModule().startVncSession(input.host, input.port, input.sessionToken, input.direct ?? false),
    ),
  stopVncSession: (sessionId: string) => getRawModule().stopVncSession(sessionId),

  logoutTailnet: () => parseJson<TailnetState>(getRawModule().logoutTailnet()),
  reauthenticateTailnet: () => parseJson<TailnetState>(getRawModule().reauthenticateTailnet()),
  resetTailnetIdentity: () => parseJson<TailnetState>(getRawModule().resetTailnetIdentity()),
  setTailscaleHostname: (hostname: string) =>
    parseJson<TailscaleHostnameResult>(getRawModule().setTailscaleHostname(hostname)),

  getSecureStorageStatus: (): Promise<SecureStorageStatus> =>
    parseJson<SecureStorageStatus>(getRawModule().getSecureStorageStatus()),
  canUseSecureStorage: async (): Promise<boolean> =>
    (await NomadNativeModule.getSecureStorageStatus()).available,
  getMachinePassword: (machineId: string) =>
    getRawModule().getSecureItem(PASSWORD_KEY_PREFIX + machineId),
  setMachinePassword: (machineId: string, password: string) =>
    getRawModule().setSecureItem(PASSWORD_KEY_PREFIX + machineId, password),
  deleteMachinePassword: (machineId: string) =>
    getRawModule().deleteSecureItem(PASSWORD_KEY_PREFIX + machineId),
  getAccountToken: () => getRawModule().getSecureItem(ACCOUNT_TOKEN_KEY),
  setAccountToken: (token: string) => getRawModule().setSecureItem(ACCOUNT_TOKEN_KEY, token),
  deleteAccountToken: () => getRawModule().deleteSecureItem(ACCOUNT_TOKEN_KEY),

  // No sidecar process on mobile — the GoMobile engine is embedded
  // in-process and initialized when the native module loads.
  getSidecarStatus: async (): Promise<SidecarStatus> => ({ running: true }),
  getAppVersion: () => getRawModule().getAppVersion(),

  readClipboard: async (): Promise<string> =>
    (await getRawModule().readClipboard()) ?? "",
  writeClipboard: (text: string) => getRawModule().writeClipboard(text),
  getClipboardChangeToken: async (): Promise<string> =>
    (await getRawModule().getClipboardChangeToken()) ?? "",

  getViewerAssetBaseUrl: () => getRawModule().getViewerAssetBaseUrl(),
  storageGetItem: (key: string) => getRawModule().storageGetItem(key),
  storageSetItem: (key: string, value: string) => getRawModule().storageSetItem(key, value),
  storageRemoveItem: (key: string) => getRawModule().storageRemoveItem(key),

  subscribe: (listener: (event: NomadNativeEvent) => void) => {
    const emitter = new NativeEventEmitter(NativeModules.NomadNativeModule);
    const subscription = emitter.addListener("NomadNativeEvent", listener);
    return () => subscription.remove();
  },
};
