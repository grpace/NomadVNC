import type {
  ConnectionState,
  PeerDevice,
  TailnetState,
} from "@nomadvnc/domain";

export type { ConnectionState, PeerDevice, TailnetState };

export interface StartVncSessionInput {
  host: string;
  port: number;
  sessionToken: string;
  preferredLocalPort?: number;
  /**
   * True when the user typed a manual host/IP rather than picking a tailnet
   * device. The sidecar skips the tailnet-login gate for direct targets and
   * dials via the OS network when the tailnet isn't up — the local-first
   * path. Tailnet-only targets (100.64.0.0/10, MagicDNS) still need login
   * and fail with a clear error when it isn't available.
   */
  direct?: boolean;
}

export interface StartVncSessionResult {
  sessionId: string;
  wsUrl: string;
  httpBaseUrl?: string;
}

export interface ConnectionStateEvent {
  type: "connectionState";
  sessionId: string;
  state: ConnectionState;
  message?: string;
}

export interface TailnetStateEvent {
  type: "tailnetState";
  state: TailnetState;
}

export interface AuthUrlEvent {
  type: "authUrl";
  authUrl: string;
}

export interface ErrorEvent {
  type: "error";
  scope: "tailnet" | "session" | "storage";
  message: string;
  sessionId?: string;
}

export interface WindowState {
  isFullScreen: boolean;
  isMaximized: boolean;
}

/** Native window-frame fallback (tiling window managers). */
export interface NativeFrameConfig {
  /** Effective value: native OS frame instead of the custom frameless chrome. */
  enabled: boolean;
  /** True when NOMADVNC_NATIVE_FRAME overrides the Settings choice. */
  managedByEnv: boolean;
}

/** Health of the Go sidecar process that owns the Tailscale identity. */
export interface SidecarStatus {
  /** Whether the sidecar process is currently running. */
  running: boolean;
  /**
   * Present only when a start failure (missing binary, spawn error,
   * unexpected exit) was recorded. Absent while the first startup is
   * still in flight.
   */
  message?: string;
}

/** Lifecycle of the in-app self-update (electron-updater). */
export type UpdateState =
  | "idle"
  | "checking"
  | "not-available"
  | "available"
  | "downloading"
  | "ready"
  | "error";

export interface UpdateStatus {
  state: UpdateState;
  /** New version when state is available/downloading/ready. */
  version?: string;
  /** 0–100 while downloading. */
  percent?: number;
  /** Human-readable detail for not-available/error states. */
  message?: string;
  /** ISO timestamp of the last completed check. */
  lastChecked?: string;
  /**
   * Set when the update can't install itself (unsigned macOS build, or a
   * package install without permission): where to download it by hand.
   */
  manualDownloadUrl?: string;
}

export interface UpdatePrefs {
  /** Master switch: when false, no automatic or manual checks run. */
  enabled: boolean;
  /** Check automatically on startup and periodically. */
  autoCheck: boolean;
}

/**
 * How tailnet traffic reaches a host: a direct UDP path, a DERP-relayed
 * path, or unknown. Latency is a best-effort disco-ping sample and is
 * absent when only status data was available.
 */
export interface PeerPathInfo {
  host: string;
  found: boolean;
  path: "direct" | "relay" | "unknown";
  latencyMs?: number;
  relayRegion?: string;
  endpoint?: string;
}

/** Desktop: Electron safeStorage; OS keyring / Secret Service on Linux. */
export interface SecureStorageStatus {
  available: boolean;
  /** Node/OS id (e.g. linux, darwin; mobile may use ios/android). */
  platform: string;
  /** Electron backend when exposed (e.g. gnome-libsecret, kwallet5). */
  backend?: string;
  /** Short guidance when `available` is false (e.g. Linux keyring). */
  hint?: string;
}

/**
 * One account-backend HTTP call proxied through the desktop main process.
 * The renderer's CSP only allows loopback connections and a `file://`
 * origin can't satisfy CORS, so account traffic runs in the main process.
 */
export interface AccountHttpRequest {
  url: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  headers: Record<string, string>;
  body?: string;
}

export interface AccountHttpResponse {
  status: number;
  body: string;
}

/** The tailnet name configured for this device. `applied` means a running node was renamed. */
export interface TailscaleHostnameResult {
  hostname: string;
  applied: boolean;
}

export type NomadNativeEvent =
  | ConnectionStateEvent
  | TailnetStateEvent
  | AuthUrlEvent
  | ErrorEvent;

export interface NomadNativePlatform {
  ensureTailnetReady(): Promise<TailnetState>;
  getTailnetPeers(): Promise<PeerDevice[]>;
  startVncSession(input: StartVncSessionInput): Promise<StartVncSessionResult>;
  stopVncSession(sessionId: string): Promise<void>;
  getTailnetState(): Promise<TailnetState>;
  getPeerPath(host: string): Promise<PeerPathInfo>;
  /** Health of the Go sidecar process (drives the failure/remediation banner). */
  getSidecarStatus(): Promise<SidecarStatus>;
  /** Current app self-update state (electron-updater on desktop). */
  getUpdateStatus(): Promise<UpdateStatus>;
  getUpdatePrefs(): Promise<UpdatePrefs>;
  setUpdatePrefs(prefs: UpdatePrefs): Promise<UpdatePrefs>;
  /** Manual update check; resolves with the resulting status. */
  checkForUpdates(): Promise<UpdateStatus>;
  /** Restart the app to install a downloaded update. */
  installUpdate(): Promise<void>;
  /** App version string for the Updates settings section. */
  getAppVersion(): Promise<string>;
  /**
   * Packaged Windows installs only. Null when there is no NSIS uninstaller
   * beside the executable (dev, macOS, Linux).
   */
  getWindowsInstall?(): Promise<{ uninstallerPath: string } | null>;
  /** Opens the Windows uninstaller and quits. Rejects when not installed. */
  uninstallWindowsApp?(): Promise<void>;
  /** Subscribe to update-status changes; returns an unsubscribe function. */
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void;
  /** Signs the embedded node out (switch-account path); keeps the stored identity. */
  logoutTailnet(): Promise<TailnetState>;
  /** Forces a fresh interactive sign-in even while the node is still running (expiring-soon path). */
  reauthenticateTailnet(): Promise<TailnetState>;
  /**
   * Wipes the persistent tsnet identity so the next bring-up registers a
   * brand-new device. Escape hatch for revoked/deleted node keys.
   */
  resetTailnetIdentity(): Promise<TailnetState>;
  /**
   * Sets this device's tailnet name. An empty string restores the
   * automatic name. Does not start Tailscale. When the node is already
   * connected, the name updates immediately.
   */
  setTailscaleHostname(hostname: string): Promise<TailscaleHostnameResult>;
  canUseSecureStorage(): Promise<boolean>;
  getSecureStorageStatus(): Promise<SecureStorageStatus>;
  getMachinePassword(machineId: string): Promise<string | null>;
  setMachinePassword(machineId: string, password: string): Promise<void>;
  deleteMachinePassword(machineId: string): Promise<void>;
  /** Nomad account JWT in OS secure storage (never localStorage). */
  getAccountToken(): Promise<string | null>;
  setAccountToken(token: string): Promise<void>;
  deleteAccountToken(): Promise<void>;
  toggleFullscreen(): Promise<boolean>;
  getFullscreen(): Promise<boolean>;
  getWindowState(): Promise<WindowState>;
  minimizeWindow(): Promise<void>;
  toggleMaximizeWindow(): Promise<boolean>;
  closeWindow(): Promise<void>;
  /** Native window-frame fallback config (tiling WMs). Takes effect on restart. */
  getNativeFrame(): Promise<NativeFrameConfig>;
  setNativeFrame(enabled: boolean): Promise<NativeFrameConfig>;
  /** Restarts the app (applies window-chrome changes). */
  relaunchApp(): Promise<void>;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  subscribe(listener: (event: NomadNativeEvent) => void): () => void;
  subscribeWindowState(listener: (state: WindowState) => void): () => void;
  /**
   * Performs an account-backend request from the main process (http/https
   * only). Desktop only; rejects when the server is unreachable.
   */
  accountRequest?(request: AccountHttpRequest): Promise<AccountHttpResponse>;
  /**
   * Fired when the OS delivers a `nomadvnc://auth/callback` deep link
   * (magic-link sign-in). Desktop only — mobile/web bridges omit it and
   * the renderer must guard with a typeof check.
   */
  onAuthCallback?(listener: (token: string) => void): () => void;
  /**
   * Fired when the menu bar's Settings item is chosen. Desktop only.
   */
  onOpenSettings?(listener: () => void): () => void;
}

/**
 * The native surface the mobile app actually implements. Desktop-only
 * concerns (window controls, in-app updates, native frame) are omitted —
 * mobile updates come from the app store and there are no OS windows to
 * manage. The embedded GoMobile engine replaces the sidecar process, so
 * `getSidecarStatus` reports the in-process engine state.
 *
 * Mobile-only additions:
 * - `getViewerAssetBaseUrl()` — the native module runs a loopback HTTP
 *   server for the viewer JS assets (`viewer-runtime.js`,
 *   `viewer-bootstrap.mjs`); the WebView loads them from here so no
 *   custom URL-scheme handler or WebView surgery is needed.
 */
export type NomadMobilePlatform = Pick<
  NomadNativePlatform,
  | "ensureTailnetReady"
  | "getTailnetPeers"
  | "startVncSession"
  | "stopVncSession"
  | "getTailnetState"
  | "getPeerPath"
  | "logoutTailnet"
  | "reauthenticateTailnet"
  | "resetTailnetIdentity"
  | "setTailscaleHostname"
  | "canUseSecureStorage"
  | "getSecureStorageStatus"
  | "getMachinePassword"
  | "setMachinePassword"
  | "deleteMachinePassword"
  | "getAccountToken"
  | "setAccountToken"
  | "deleteAccountToken"
  | "getSidecarStatus"
  | "getAppVersion"
  | "readClipboard"
  | "writeClipboard"
  | "subscribe"
> & {
  /**
   * Simple string key-value storage (SharedPreferences on Android,
   * UserDefaults on iOS). For non-secret app settings — secrets go
   * through the secure-storage methods.
   */
  storageGetItem(key: string): Promise<string | null>;
  storageSetItem(key: string, value: string): Promise<void>;
  storageRemoveItem(key: string): Promise<void>;
  /**
   * Base URL (e.g. `http://127.0.0.1:PORT`) of the loopback asset server
   * the native module runs for the viewer JS. Served with
   * `Access-Control-Allow-Origin: *` so the WebView can load the
   * bootstrap as a module script.
   */
  getViewerAssetBaseUrl(): Promise<string>;
  /**
   * Opaque value that changes whenever the device clipboard changes
   * ("" when it holds no text). Reading it never touches the clipboard's
   * contents, so it doesn't trigger Android's "pasted from your
   * clipboard" toast or iOS's paste prompt — the app reads the text only
   * when this changes.
   */
  getClipboardChangeToken(): Promise<string>;
};
