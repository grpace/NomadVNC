import type { Dispatch, SetStateAction } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { describeKeyExpiry, formatDaysLeft } from "./keyExpiry";
import {
  defaultViewPrefsFromSettings,
  loadAppSettings,
  persistAppSettings,
  sanitizeAppSettings,
  type AppSettings,
} from "./appSettings";
import type { Collection, PeerDevice, SavedMachine, TailnetState } from "@nomadvnc/domain";
import { isManualMachine, manualStableId, resolveMachineHost } from "@nomadvnc/domain";
import type {
  NomadNativeEvent,
  NomadNativePlatform,
  NativeFrameConfig,
  PeerPathInfo,
  SecureStorageStatus,
  SidecarStatus,
  WindowState,
} from "@nomadvnc/platform-contracts";
import { createViewerHtml } from "@nomadvnc/viewer-shell";
import viewerBootstrapUrl from "@nomadvnc/viewer-shell/bootstrap?url";
import viewerInputUrl from "@nomadvnc/viewer-shell/input?url";
import { AccountClient, AccountApiError, createAccountFetch } from "./accountClient";
import type { BackendSharedDeviceView, BackendShareView, ShareGrantInput } from "./accountClient";
import { loadAccountConfig, persistAccountConfig } from "./accountConfig";
import { decodeAccountEmail, tokenRefreshDue, type AccountSession } from "./accountSession";
import {
  downloadAccountLibrary,
  loadSyncState,
  persistSyncState,
  pushSavedMachine,
  tailnetGateMessage,
  uploadLocalLibrary,
} from "./accountSync";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  WindowCloseIcon,
  WindowMaximizeIcon,
  WindowMinimizeIcon,
  WindowRestoreIcon,
} from "./components/icons";
import {
  createGuestMachineFromPeer,
  createManualMachine,
  loadSavedMachines,
  persistSavedMachines,
  reconcileSavedMachines,
  setMachineCollection,
  touchSavedMachineConnection,
  upsertSavedMachine,
} from "./localMachines";
import {
  createCollection,
  deleteCollection,
  loadCollections,
  persistCollections,
} from "./collections";
import {
  getMachineViewPrefs,
  loadMachineViewPrefs,
  persistMachineViewPrefs,
  setMachineViewPrefs,
  type MachineViewPrefsMap,
} from "./machineViewPrefs";
import { formatLastSeenSuffix, getMachinePresence } from "./presence";
import { AUTO_RECONNECT_MAX_ATTEMPTS, SessionReconnectController } from "./sessionReconnect";
import { AccountPanel } from "./components/AccountPanel";
import { ShareDialog } from "./components/ShareDialog";
import { SidebarHeader } from "./components/SidebarHeader";
import { SettingsPanel } from "./components/SettingsPanel";
import { QuickConnect } from "./components/QuickConnect";
import { ConnectionForm } from "./components/ConnectionForm";
import { PasswordPromptModal } from "./components/PasswordPromptModal";
import { StatusToast } from "./components/StatusToast";
import { ViewerPanel, type ViewerConnectionState } from "./components/ViewerPanel";
import { ViewerPlaceholder } from "./components/ViewerPlaceholder";

declare global {
  interface Window {
    nomadNative: NomadNativePlatform;
  }
}

type SidebarTab = "machines" | "form" | "account" | "settings";
type StatusVariant = "info" | "success" | "error" | "connecting" | "disconnecting";

interface ActiveSession {
  sessionId: string;
  wsUrl: string;
  password?: string;
  /** Passed to noVNC for macOS ARD; optional for standard VNC password–only servers. */
  vncUsername?: string;
  machineId?: string;
  label: string;
  host: string;
  port: number;
  /** True when the session targets a user-typed address (local-first path). */
  direct: boolean;
}

interface StatusState {
  message: string;
  variant: StatusVariant;
}

/** Mirrors the stacking `@media` rule in styles.css. */
const STACKED_LAYOUT_QUERY = "(max-width: 768px), (max-width: 960px) and (aspect-ratio < 1)";

function sortPeers(peers: PeerDevice[]): PeerDevice[] {
  return [...peers].sort((left, right) => {
    if (left.online !== right.online) {
      return left.online ? -1 : 1;
    }

    return left.displayName.localeCompare(right.displayName);
  });
}

/** Tailscale sign-in prompts use `connecting`, which skips auto-dismiss; clear them once logged in. */
const TAILSCALE_SIGNIN_TOAST_MESSAGES = new Set([
  "Waiting for Tailscale sign-in",
  "Continue Tailscale sign-in in your browser",
]);

function clearTailscaleSignInToast(setStatus: Dispatch<SetStateAction<StatusState>>): void {
  setStatus((prev) => {
    if (prev.variant === "connecting" && TAILSCALE_SIGNIN_TOAST_MESSAGES.has(prev.message)) {
      return { message: "Idle", variant: "info" };
    }
    return prev;
  });
}

function secureStorageUnavailableMessage(status: SecureStorageStatus): string {
  if (status.platform === "linux") {
    const backend = status.backend ? ` (${status.backend})` : "";
    return `Secure storage unavailable${backend}. Ensure KDE Wallet/keyring is unlocked and restart NomadVNC.`;
  }
  return "Secure local storage is unavailable on this system";
}

export function App() {
  // --- Core state ---
  const [tailnetState, setTailnetState] = useState<TailnetState | null>(null);
  const [sidecarStatus, setSidecarStatus] = useState<SidecarStatus | null>(null);
  const [peers, setPeers] = useState<PeerDevice[]>([]);
  const [savedMachines, setSavedMachines] = useState<SavedMachine[]>(() => loadSavedMachines());
  const [collections, setCollections] = useState<Collection[]>(() => loadCollections());
  const [machineViewPrefs, setMachineViewPrefsState] = useState<MachineViewPrefsMap>(() => loadMachineViewPrefs());
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [connectingMachineId, setConnectingMachineId] = useState<string | null>(null);
  const [viewerHtml, setViewerHtml] = useState("");

  // --- Nomad account (optional; local mode works without it) ---
  const [accountSession, setAccountSession] = useState<AccountSession | null>(null);
  const [accountBaseUrl, setAccountBaseUrl] = useState(() => loadAccountConfig().baseUrl);
  const [lastAccountSyncAt, setLastAccountSyncAt] = useState<string | null>(null);
  const [sharedDevices, setSharedDevices] = useState<BackendSharedDeviceView[]>([]);
  const [sharingMachine, setSharingMachine] = useState<SavedMachine | null>(null);
  const [machineShares, setMachineShares] = useState<BackendShareView[]>([]);
  const [loadingShares, setLoadingShares] = useState(false);
  const accountSessionRef = useRef<AccountSession | null>(null);
  /** Latest magic-link consumer for the OS deep-link subscription (avoids a stale accountClient). */
  const consumeMagicLinkRef = useRef<(token: string) => Promise<void>>(async () => {});
  const accountSyncInFlightRef = useRef(false);
  const accountBootSyncedRef = useRef<string | null>(null);
  useEffect(() => {
    accountSessionRef.current = accountSession;
  }, [accountSession]);
  const accountClient = useMemo(
    () =>
      new AccountClient(
        accountBaseUrl,
        () => accountSessionRef.current?.token ?? null,
        createAccountFetch(window.nomadNative),
      ),
    [accountBaseUrl],
  );

  /** Dead-token recovery: drop the local session, stay useful in local mode. */
  const handleAccountExpired = useCallback(async (): Promise<void> => {
    try {
      await window.nomadNative.deleteAccountToken?.();
    } catch {
      // Keyring cleanup is best-effort.
    }
    accountSessionRef.current = null;
    setAccountSession(null);
    // Next sign-in re-uploads: signed-out edits must not be dropped by a download.
    persistSyncState({ uploadedForEmail: null, lastAccountEmail: loadSyncState().lastAccountEmail });
    setSharedDevices([]);
    setSharingMachine(null);
    setStatus({ message: "Nomad session expired. Continuing in local mode.", variant: "error" });
  }, []);

  /**
   * Sliding sign-in: swap the account token for a fresh one once it is
   * getting old, so a regularly used app never signs out. Offline or a
   * server error keeps the current token; only a 401 ends the session.
   */
  const accountRefreshInFlightRef = useRef(false);
  const refreshAccountSessionIfDue = useCallback(async (): Promise<void> => {
    const session = accountSessionRef.current;
    if (!session || accountRefreshInFlightRef.current || !tokenRefreshDue(session.token)) {
      return;
    }
    accountRefreshInFlightRef.current = true;
    try {
      const token = await accountClient.refreshSession();
      // Signed out (or in again) while the request was out.
      if (accountSessionRef.current !== session) {
        return;
      }
      try {
        await window.nomadNative.setAccountToken?.(token);
      } catch {
        // Keyring trouble: the fresh token still works until restart.
      }
      const next = { token, email: decodeAccountEmail(token) ?? session.email };
      accountSessionRef.current = next;
      setAccountSession(next);
    } catch (error) {
      if (error instanceof AccountApiError && error.status === 401 && accountSessionRef.current === session) {
        await handleAccountExpired();
      }
    } finally {
      accountRefreshInFlightRef.current = false;
    }
  }, [accountClient, handleAccountExpired]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void refreshAccountSessionIfDue();
    }, 60 * 60_000);
    return () => window.clearInterval(timer);
  }, [refreshAccountSessionIfDue]);

  /** Best-effort refresh of the "shared with me" section; quiet unless the session died. */
  const refreshSharing = useCallback(async (): Promise<void> => {
    if (!accountSessionRef.current) {
      setSharedDevices([]);
      return;
    }
    try {
      setSharedDevices(await accountClient.listSharedDevices());
    } catch (error) {
      if (error instanceof AccountApiError && error.status === 401) {
        await handleAccountExpired();
      }
      // Advisory section — sync already reported; don't toast twice.
    }
  }, [accountClient, handleAccountExpired]);

  /**
   * Server-authoritative sync: first sign-in uploads locals, then every
   * sync downloads + replaces. A failed upload keeps the local library
   * (never silently drop unsynced machines); saves/deletes push through
   * first elsewhere so there is normally nothing to lose.
   */
  const synchronizeAccountLibrary = useCallback(async (email: string, force: boolean): Promise<void> => {
    if (accountSyncInFlightRef.current) {
      return;
    }
    if (!force && accountBootSyncedRef.current === email) {
      return;
    }
    accountBootSyncedRef.current = email;
    accountSyncInFlightRef.current = true;
    try {
      // Account sync is plain HTTPS against the Nomad backend: it works
      // without the tailnet (Tailscale is optional). Only sharing keeps the
      // tailnet gate — it releases credentials to other people and its
      // key-passing transport is tailnet-native.
      const locals = savedMachinesRef.current;
      const collections = collectionsRef.current;
      if (loadSyncState().uploadedForEmail !== email && locals.length > 0) {
        const readKeyringPassword = typeof window.nomadNative.getMachinePassword === "function"
          ? (id: string) => window.nomadNative.getMachinePassword(id).catch(() => null)
          : async (_id: string) => null;
        const result = await uploadLocalLibrary(accountClient, locals, collections, readKeyringPassword);
        if (result.failed.length > 0) {
          setStatus({
            message: `Sync: ${result.failed.length} machine(s) failed to upload. Local library kept.`,
            variant: "error",
          });
          return;
        }
        if (result.uploaded > 0) {
          const extra = result.metadataOnly.length > 0
            ? ` (${result.metadataOnly.length} without a readable password: metadata only)`
            : "";
          setStatus({ message: `Uploaded ${result.uploaded} machine(s) to Nomad account${extra}`, variant: "success" });
        }
      }
      const next = await downloadAccountLibrary(accountClient, savedMachinesRef.current, collectionsRef.current);
      setSavedMachines(next);
      persistSyncState({ uploadedForEmail: email, lastAccountEmail: email });
      setLastAccountSyncAt(new Date().toISOString());
      setStatus({ message: `Synced ${next.length} machine(s) from Nomad account`, variant: "success" });
      await refreshSharing();
    } catch (error) {
      if (error instanceof AccountApiError && error.status === 401) {
        await handleAccountExpired();
        return;
      }
      setStatus({
        message: error instanceof Error ? `Account sync failed: ${error.message}` : "Account sync failed",
        variant: "error",
      });
    } finally {
      accountSyncInFlightRef.current = false;
    }
  }, [accountClient, handleAccountExpired, refreshSharing]);

  /** Best-effort restore: older stubs (and some tests) lack the keyring bridge. */
  const restoreAccountSession = useCallback(async (): Promise<AccountSession | null> => {
    try {
      const getToken = window.nomadNative.getAccountToken;
      if (typeof getToken !== "function") {
        return null;
      }
      const token = await getToken();
      if (!token) {
        return null;
      }
      const session = { token, email: decodeAccountEmail(token) ?? "Nomad account" };
      accountSessionRef.current = session;
      setAccountSession(session);
      return session;
    } catch {
      // No stored session — stay in local mode.
      return null;
    }
  }, []);

  async function handleRequestMagicLink(email: string): Promise<void> {
    await accountClient.requestMagicLink(email);
  }

  async function handleConsumeMagicLink(token: string): Promise<void> {
    const jwt = await accountClient.consumeMagicLink(token);
    const session = { token: jwt, email: decodeAccountEmail(jwt) ?? "Nomad account" };
    try {
      await window.nomadNative.setAccountToken?.(jwt);
    } catch {
      // Keyring failures shouldn't block the session itself; the token
      // simply won't survive a restart.
    }
    accountSessionRef.current = session;
    setAccountSession(session);
    setStatus({ message: "Signed in to Nomad account", variant: "success" });
    await synchronizeAccountLibrary(session.email, true);
  }
  consumeMagicLinkRef.current = handleConsumeMagicLink;

  async function handleAccountSignOut(): Promise<void> {
    try {
      await accountClient.logout();
    } catch {
      // Server logout is best-effort (offline counts too); the local
      // token is always discarded below.
    }
    try {
      await window.nomadNative.deleteAccountToken?.();
    } catch {
      // Keyring cleanup is best-effort.
    }
    accountSessionRef.current = null;
    setAccountSession(null);
    // Next sign-in re-uploads: signed-out edits must not be dropped by a download.
    // lastAccountEmail survives so the UI can surface pending uploads.
    persistSyncState({ uploadedForEmail: null, lastAccountEmail: loadSyncState().lastAccountEmail });
    setSharedDevices([]);
    setSharingMachine(null);
    setStatus({ message: "Signed out of Nomad account", variant: "info" });
  }

  /** Deletes the account on the server; machines on this computer stay. */
  async function handleAccountDelete(): Promise<void> {
    // Errors propagate to the panel: nothing local changes unless the
    // server confirms the deletion.
    await accountClient.deleteAccount();
    try {
      await window.nomadNative.deleteAccountToken?.();
    } catch {
      // Keyring cleanup is best-effort; the token is dead server-side anyway.
    }
    accountSessionRef.current = null;
    setAccountSession(null);
    // Nothing is pending upload to an account that no longer exists.
    persistSyncState({ uploadedForEmail: null, lastAccountEmail: null });
    setSharedDevices([]);
    setSharingMachine(null);
    setStatus({ message: "Nomad account deleted. Machines saved on this computer were kept.", variant: "info" });
  }

  async function handleSyncNow(): Promise<void> {
    const session = accountSessionRef.current;
    if (!session) {
      return;
    }
    await synchronizeAccountLibrary(session.email, true);
  }

  /** Share calls that hit a dead token close the dialog and drop the session. */
  async function shareCall<T>(task: () => Promise<T>): Promise<T> {
    const gated = tailnetGateMessage(tailnetStateRef.current, "to manage sharing");
    if (gated) {
      throw new Error(gated);
    }
    try {
      return await task();
    } catch (error) {
      if (error instanceof AccountApiError && error.status === 401) {
        setSharingMachine(null);
        await handleAccountExpired();
      }
      throw error;
    }
  }

  async function openShareDialog(machine: SavedMachine): Promise<void> {
    const gated = tailnetGateMessage(tailnetStateRef.current, "to manage sharing");
    if (gated) {
      setStatus({ message: gated, variant: "error" });
      return;
    }
    setSharingMachine(machine);
    setMachineShares([]);
    setLoadingShares(true);
    try {
      setMachineShares(await shareCall(() => accountClient.listShares(machine.id)));
    } catch (error) {
      setStatus({
        message: error instanceof Error ? `Couldn't load grants: ${error.message}` : "Couldn't load grants",
        variant: "error",
      });
    } finally {
      setLoadingShares(false);
    }
  }

  async function handleGrantShare(input: ShareGrantInput): Promise<{ inviteSent: boolean }> {
    const machine = sharingMachine;
    if (!machine) {
      throw new Error("No machine selected for sharing");
    }
    const result = await shareCall(() => accountClient.createShare(machine.id, input));
    setMachineShares(await shareCall(() => accountClient.listShares(machine.id)));
    return result;
  }

  async function handleRekeyShare(shareId: string, key: string, expiresAtIso: string): Promise<void> {
    const machine = sharingMachine;
    if (!machine) {
      return;
    }
    await shareCall(() => accountClient.updateShareKey(machine.id, shareId, { tailnetAuthKey: key, keyExpiresAt: expiresAtIso }));
    setMachineShares(await shareCall(() => accountClient.listShares(machine.id)));
  }

  async function handleClearShareKey(shareId: string): Promise<void> {
    const machine = sharingMachine;
    if (!machine) {
      return;
    }
    await shareCall(() => accountClient.updateShareKey(machine.id, shareId, { tailnetAuthKey: null }));
    setMachineShares(await shareCall(() => accountClient.listShares(machine.id)));
  }

  async function handleRevokeShare(shareId: string): Promise<void> {
    const machine = sharingMachine;
    if (!machine) {
      return;
    }
    await shareCall(() => accountClient.deleteShare(machine.id, shareId));
    setMachineShares(await shareCall(() => accountClient.listShares(machine.id)));
  }

  function handleAccountBaseUrlChange(baseUrl: string): void {
    persistAccountConfig({ baseUrl });
    setAccountBaseUrl(baseUrl);
  }

  // --- Form state ---
  const [appSettings, setAppSettings] = useState<AppSettings>(loadAppSettings);

  /** Merges a partial settings update into state and localStorage. */
  function updateAppSettings(partial: Partial<AppSettings>): void {
    setAppSettings((current) => {
      const next = sanitizeAppSettings({ ...current, ...partial });
      persistAppSettings(next);
      return next;
    });
  }

  const [selectedPeerId, setSelectedPeerId] = useState("");
  const [manualHost, setManualHost] = useState("");
  const [selectedMachineId, setSelectedMachineId] = useState("");
  const [machineLabel, setMachineLabel] = useState("");
  const [vncPort, setVncPort] = useState(() => String(appSettings.defaultVncPort));
  const [vncUsername, setVncUsername] = useState("");
  const [password, setPassword] = useState("");
  const [selectedCollectionId, setSelectedCollectionId] = useState("");
  const [savePasswordSecurely, setSavePasswordSecurely] = useState(false);
  const [secureStorageStatus, setSecureStorageStatus] = useState<SecureStorageStatus | null>(null);
  const secureStorageAvailable = secureStorageStatus?.available ?? null;
  const secureStorageHint =
    secureStorageStatus && !secureStorageStatus.available
      ? secureStorageUnavailableMessage(secureStorageStatus)
      : undefined;

  useEffect(() => {
    if (secureStorageAvailable === false && savePasswordSecurely) {
      setSavePasswordSecurely(false);
    }
  }, [savePasswordSecurely, secureStorageAvailable]);

  // --- UI state ---
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("machines");
  const [status, setStatus] = useState<StatusState>({ message: "Idle", variant: "info" });
  const [isRefreshing, setIsRefreshing] = useState(false);
  /** Native-frame config from the main process (window.json / env). */
  const [nativeFrameConfig, setNativeFrameConfig] = useState<NativeFrameConfig | null>(null);
  /** Frame mode the current window was created with (topbar visibility). */
  const [nativeFrameAtBoot, setNativeFrameAtBoot] = useState<boolean | null>(null);
  const [sessionHint, setSessionHint] = useState("Choose a machine from the sidebar to start a secure VNC session.");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [viewerConnectionLost, setViewerConnectionLost] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  /** True once the viewer finished the RFB handshake; false while (re)connecting. */
  const [viewerLive, setViewerLive] = useState(false);
  /**
   * Whether the current session ever completed a handshake. A failure
   * before that is "couldn't connect" (wrong port, server not running):
   * reported at once instead of five "connection lost" retries.
   */
  const sessionEverLiveRef = useRef(false);
  const [viewerNeverConnected, setViewerNeverConnected] = useState(false);
  const [sessionKey, setSessionKey] = useState(0);
  /** Proxy session replaced by a reconnect, stopped after the new viewer mounts. */
  const supersededSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    const superseded = supersededSessionIdRef.current;
    if (!superseded) {
      return;
    }
    supersededSessionIdRef.current = null;
    void Promise.resolve().then(() => window.nomadNative.stopVncSession(superseded)).catch(() => {
      // The old proxy session is already dead; cleanup is best-effort.
    });
  }, [sessionKey]);
  const activeSessionIdRef = useRef<string | null>(null);
  const activeSessionRef = useRef<ActiveSession | null>(null);
  const peersRef = useRef<PeerDevice[]>([]);
  const savedMachinesRef = useRef<SavedMachine[]>([]);
  const collectionsRef = useRef<Collection[]>([]);
  const tailnetStateRef = useRef<TailnetState | null>(null);
  const passwordModalResolveRef = useRef<((value: string | null) => void) | null>(null);
  const [passwordModal, setPasswordModal] = useState<null | { title: string; body: string; submitLabel?: string }>(null);

  const requestPasswordPrompt = useCallback((title: string, body: string, submitLabel?: string): Promise<string | null> => {
    return new Promise((resolve) => {
      passwordModalResolveRef.current = resolve;
      setPasswordModal({ title, body, submitLabel });
    });
  }, []);

  const completePasswordPrompt = useCallback((value: string | null) => {
    const resolve = passwordModalResolveRef.current;
    passwordModalResolveRef.current = null;
    setPasswordModal(null);
    resolve?.(value);
  }, []);

  useEffect(() => {
    activeSessionIdRef.current = activeSession?.sessionId ?? null;
    activeSessionRef.current = activeSession;
  }, [activeSession]);

  useEffect(() => {
    peersRef.current = peers;
  }, [peers]);

  useEffect(() => {
    savedMachinesRef.current = savedMachines;
  }, [savedMachines]);

  useEffect(() => {
    collectionsRef.current = collections;
  }, [collections]);

  useEffect(() => {
    tailnetStateRef.current = tailnetState;
  }, [tailnetState]);

  const refreshSecureStorageStatus = useCallback(async (): Promise<SecureStorageStatus> => {
    try {
      const next = await window.nomadNative.getSecureStorageStatus();
      setSecureStorageStatus(next);
      return next;
    } catch {
      const fallback: SecureStorageStatus = { available: false, platform: "unknown" };
      setSecureStorageStatus(fallback);
      return fallback;
    }
  }, []);

  const handleSavePasswordSecurelyChange = useCallback(async (checked: boolean): Promise<void> => {
    if (!checked) {
      setSavePasswordSecurely(false);
      return;
    }

    const next = await refreshSecureStorageStatus();
    if (next.available) {
      setSavePasswordSecurely(true);
      return;
    }

    setSavePasswordSecurely(false);
    setStatus({
      message: secureStorageUnavailableMessage(next),
      variant: "error",
    });
  }, [refreshSecureStorageStatus]);

  // Auto-expand sidebar when session ends
  useEffect(() => {
    if (!activeSession && sidebarCollapsed) {
      setSidebarCollapsed(false);
    }
  }, [activeSession, sidebarCollapsed]);

  // --- Persist saved machines ---
  useEffect(() => {
    persistSavedMachines(savedMachines);
  }, [savedMachines]);

  // --- Persist per-machine view prefs ---
  useEffect(() => {
    persistMachineViewPrefs(machineViewPrefs);
  }, [machineViewPrefs]);

  // --- Persist groups ---
  useEffect(() => {
    persistCollections(collections);
  }, [collections]);

  // --- Tailnet path health for the live session ---
  const [connectionPath, setConnectionPath] = useState<PeerPathInfo | null | undefined>(undefined);
  /** Re-samples the path now (the viewer says the session stopped answering). */
  const resampleConnectionPathRef = useRef<() => void>(() => {});
  useEffect(() => {
    if (!activeSession) {
      setConnectionPath(undefined);
      return;
    }
    // Direct (address) sessions don't ride the tailnet: a path verdict
    // would be meaningless ("No path"), so the chip stays hidden.
    if (activeSession.direct) {
      setConnectionPath(null);
      return;
    }
    const host = activeSession.host;
    let cancelled = false;

    async function refreshPath(): Promise<void> {
      try {
        if (typeof window.nomadNative.getPeerPath !== "function") {
          if (!cancelled) {
            setConnectionPath(null);
          }
          return;
        }
        const info = await window.nomadNative.getPeerPath(host);
        if (!cancelled) {
          setConnectionPath(info);
        }
      } catch {
        // Diagnostics are advisory; a failed sample hides the chip.
        if (!cancelled) {
          setConnectionPath(null);
        }
      }
    }

    setConnectionPath(undefined);
    void refreshPath();
    resampleConnectionPathRef.current = () => {
      // "Checking…" until the fresh sample lands, so a stale verdict
      // doesn't explain the stall.
      setConnectionPath(undefined);
      void refreshPath();
    };
    const timer = window.setInterval(() => {
      void refreshPath();
    }, 15000);
    return () => {
      cancelled = true;
      resampleConnectionPathRef.current = () => {};
      window.clearInterval(timer);
    };
  }, [activeSession]);

  // --- Fullscreen management ---
  async function handleToggleFullscreen(): Promise<void> {
    try {
      const nowFullscreen = await window.nomadNative.toggleFullscreen();
      setIsFullscreen(nowFullscreen);
    } catch {
      // fullscreen toggle is best-effort
    }
  }

  useEffect(() => {
    void window.nomadNative.getWindowState()
      .then((windowState: WindowState) => {
        setIsFullscreen(windowState.isFullScreen);
        setIsMaximized(windowState.isMaximized);
      })
      .catch(() => {
        // window chrome state is best-effort
      });

    return window.nomadNative.subscribeWindowState((windowState) => {
      setIsFullscreen(windowState.isFullScreen);
      setIsMaximized(windowState.isMaximized);
    });
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "F11") {
        e.preventDefault();
        void handleToggleFullscreen();
      }
      if (e.key === "Escape" && isFullscreen) {
        void handleToggleFullscreen();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isFullscreen]);

  // --- Stacked (portrait / narrow) layout detection ---
  // Must match the stacking breakpoint in styles.css so the sidebar toggle
  // arrows point the right way.
  const [isVertical, setIsVertical] = useState(() =>
    typeof window.matchMedia === "function"
      ? window.matchMedia(STACKED_LAYOUT_QUERY).matches
      : window.innerWidth < window.innerHeight,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia(STACKED_LAYOUT_QUERY);
    const handler = (e: MediaQueryListEvent) => setIsVertical(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  // In the stacked layout the sidebar sits above the viewer and would
  // leave the remote desktop a sliver, so a new session collapses it.
  const activeSessionId = activeSession?.sessionId;
  useEffect(() => {
    if (activeSessionId && isVertical) {
      setSidebarCollapsed(true);
    }
    // Only on session start, not on every orientation change.
  }, [activeSessionId]);
  // --- Auto-dismiss status toasts ---
  useEffect(() => {
    if (status.message !== "Idle" && status.variant !== "connecting") {
      const delay =
        status.variant === "error" ? 5000 : status.variant === "disconnecting" ? 2800 : 3500;
      const timer = setTimeout(() => {
        setStatus({ message: "Idle", variant: "info" });
      }, delay);
      return () => clearTimeout(timer);
    }
  }, [status]);

  async function handleMinimizeWindow(): Promise<void> {
    try {
      await window.nomadNative.minimizeWindow();
    } catch {
      // minimize is best-effort
    }
  }

  async function handleToggleMaximizeWindow(): Promise<void> {
    try {
      const nextMaximized = await window.nomadNative.toggleMaximizeWindow();
      setIsMaximized(nextMaximized);
    } catch {
      // maximize toggle is best-effort
    }
  }

  async function handleCloseWindow(): Promise<void> {
    try {
      await window.nomadNative.closeWindow();
    } catch {
      // close is best-effort
    }
  }

  // --- Tailnet management ---
  const refreshTailnet = useCallback(async (interactive: boolean): Promise<void> => {
    if (interactive) {
      setIsRefreshing(true);
    }
    try {
      const state = interactive
        ? await window.nomadNative.ensureTailnetReady()
        : await window.nomadNative.getTailnetState();

      setTailnetState(state);
      tailnetStateRef.current = state;

      if (state.loggedIn) {
        clearTailscaleSignInToast(setStatus);
        const nextPeers = sortPeers(await window.nomadNative.getTailnetPeers());
        
        // Prevent UI flickering by only updating peers if something meaningful changed
        setPeers((current) => {
          const hasChanged = current.length !== nextPeers.length || 
            current.some((p, i) => p.stableId !== nextPeers[i]?.stableId || p.online !== nextPeers[i]?.online);
          return hasChanged ? nextPeers : current;
        });

        // Update machines (reconcile handles internal change detection)
        setSavedMachines((current) => reconcileSavedMachines(current, nextPeers));
      } else {
        // Functional update: this callback is memoized with no deps, so a
        // captured `peers` would always be the initial empty list.
        setPeers((current) => (current.length > 0 ? [] : current));
        if (interactive) {
          setStatus({ message: "Waiting for Tailscale sign-in", variant: "connecting" });
        }
      }
    } catch (error) {
      // Don't noise up the UI with background errors during sidecar startup/bounce
      if (interactive) {
        setStatus({
          message: error instanceof Error ? error.message : "Unable to refresh tailnet state",
          variant: "error",
        });
      }
    } finally {
      if (interactive) {
        setIsRefreshing(false);
      }
    }
  }, []);

  /** Polls the Go sidecar health; drives the failure/remediation banner. */
  const refreshSidecarStatus = useCallback(async (): Promise<void> => {
    try {
      setSidecarStatus(await window.nomadNative.getSidecarStatus());
    } catch {
      // Sidecar health is best-effort; tailnet refresh already surfaces errors.
    }
  }, []);

  /** Retry after a sidecar failure: re-run tailnet bring-up, then re-check health. */
  async function retrySidecar(): Promise<void> {
    await refreshTailnet(true);
    await refreshSidecarStatus();
  }

  /** Tailnet sign-out (switch-account path). Refuses while a session is live. */
  async function handleSignOut(): Promise<void> {
    if (activeSession) {
      setStatus({ message: "Disconnect the current session before signing out", variant: "error" });
      return;
    }
    try {
      const state = await window.nomadNative.logoutTailnet();
      setTailnetState(state);
      setPeers([]);
      setStatus({
        message: state.loggedIn
          ? "Still signed in. Try again to switch account."
          : "Signed out of Tailscale. Sign in to rediscover devices.",
        variant: state.loggedIn ? "error" : "info",
      });
    } catch (error) {
      setStatus({
        message: error instanceof Error ? error.message : "Unable to sign out of Tailscale",
        variant: "error",
      });
    }
  }

  /** Re-authenticate the tailnet node (key expiring or expired). */
  async function handleReauthenticate(): Promise<void> {
    if (activeSession) {
      setStatus({ message: "Disconnect the current session before re-authenticating", variant: "error" });
      return;
    }
    try {
      const state = await window.nomadNative.reauthenticateTailnet();
      setTailnetState(state);
      if (state.authUrl) {
        setStatus({ message: "Continue Tailscale sign-in in your browser", variant: "connecting" });
      } else if (state.loggedIn) {
        setStatus({ message: "Tailscale sign-in refreshed", variant: "success" });
      }
    } catch (error) {
      setStatus({
        message: error instanceof Error ? error.message : "Unable to re-authenticate Tailscale",
        variant: "error",
      });
    }
  }

  /**
   * Reset the tailnet device identity (revoked/deleted node key escape hatch).
   * Wipes the stored identity and starts a fresh login; refuses while a
   * session is live, mirroring sign-out.
   */
  async function handleResetIdentity(): Promise<void> {
    if (activeSession) {
      setStatus({ message: "Disconnect the current session before resetting the tailnet identity", variant: "error" });
      return;
    }
    try {
      const resetState = await window.nomadNative.resetTailnetIdentity();
      setTailnetState(resetState);
      setPeers([]);
      // A fresh identity is never logged in: start the login flow right away.
      const state = await window.nomadNative.ensureTailnetReady();
      setTailnetState(state);
      setStatus({
        message: "Tailnet identity reset. This is a new device on your tailnet. Complete sign-in to continue.",
        variant: "info",
      });
    } catch (error) {
      setStatus({
        message: error instanceof Error ? error.message : "Unable to reset the tailnet identity",
        variant: "error",
      });
    }
  }

  /**
   * Tailnet key-expiry nudge. Amber while the key is still valid but expiring
   * soon; red once sign-in has expired. The expired banner also offers the
   * identity-reset escape hatch for revoked/deleted node keys.
   */
  function renderKeyExpiryBanner(): ReactNode {
    const info = describeKeyExpiry(tailnetState?.keyExpiry);
    if (info.status !== "expired" && info.status !== "expiringSoon") {
      return null;
    }
    const expired = info.status === "expired";
    const days = info.daysLeft === null ? "" : formatDaysLeft(info.daysLeft);
    return (
      <div className={`tailnet-banner${expired ? " tailnet-banner--expired" : ""}`} role="alert">
        <div className="tailnet-banner__title">
          {expired ? "Tailscale Sign-In Expired" : "Tailscale Key Expiring Soon"}
        </div>
        <p className="tailnet-banner__message">
          {expired
            ? "This device's Tailscale key has expired. Sign in again to keep connecting."
            : `This device's Tailscale key expires ${days}. Re-authenticate before it lapses.`}
        </p>
        {expired && (
          <p className="tailnet-banner__hint">
            If sign-in keeps failing, the node key may have been revoked or the device
            deleted. Reset the tailnet identity to register as a brand-new device.
          </p>
        )}
        <div className="tailnet-banner__actions">
          <button className="btn btn--primary btn--sm" onClick={() => void handleReauthenticate()}>
            {expired ? "Sign In Again" : "Re-authenticate"}
          </button>
          {expired && (
            <button className="btn btn--secondary btn--sm" onClick={() => void handleResetIdentity()}>
              Reset Device Identity
            </button>
          )}
        </div>
      </div>
    );
  }

  /** Native-frame fallback for tiling WMs; takes effect after restart. */
  async function handleNativeFrameChange(enabled: boolean): Promise<void> {
    try {
      const config = await window.nomadNative.setNativeFrame(enabled);
      setNativeFrameConfig(config);
    } catch (error) {
      setStatus({
        message: error instanceof Error ? error.message : "Unable to change window frame mode",
        variant: "error",
      });
    }
  }

  /** Restarts the app (applies window-chrome changes). */
  async function handleRelaunch(): Promise<void> {
    try {
      await window.nomadNative.relaunchApp();
    } catch {
      // The app is gone (or relaunch failed without a message); nothing to update.
    }
  }

  // --- Boot ---
  useEffect(() => {
    const unsubscribe = window.nomadNative.subscribe((event: NomadNativeEvent) => {
      if (event.type === "error") {
        setStatus({ message: event.message ?? "Unexpected error", variant: "error" });
      }

      if (event.type === "authUrl") {
        setStatus({ message: "Continue Tailscale sign-in in your browser", variant: "connecting" });
      }

      if (event.type === "tailnetState") {
        const next = event.state;
        if (!next) {
          return;
        }
        setTailnetState(next);
        if (next.loggedIn) {
          clearTailscaleSignInToast(setStatus);
        }
      }

      if (event.type === "connectionState") {
        // Suppress redundant internal proxy messages
        if (event.message?.toLowerCase().includes("local proxy ready")) {
          return;
        }

        if (event.state === "disconnecting") {
          if (activeSessionIdRef.current === null) {
            return;
          }
          if (event.sessionId !== activeSessionIdRef.current) {
            return;
          }
        }

        const variant: StatusVariant =
          event.state === "connected"
            ? "success"
            : event.state === "error"
              ? "error"
              : event.state === "disconnecting"
                ? "disconnecting"
                : "connecting";

        setStatus({
          message: event.message ?? `Session ${event.state}`,
          variant,
        });
      }
    });

    void refreshSecureStorageStatus();

    // OS deep-link sign-in (nomadvnc://auth/callback?token=...): consume
    // exactly like a pasted link, then show the account tab.
    const unsubscribeAuthCallback =
      typeof window.nomadNative.onAuthCallback === "function"
        ? window.nomadNative.onAuthCallback((token) => {
            void (async () => {
              if (accountSessionRef.current) {
                setStatus({ message: "Already signed in to Nomad account", variant: "info" });
                return;
              }
              try {
                await consumeMagicLinkRef.current(token);
                setSidebarTab("account");
              } catch (error) {
                setStatus({
                  message: error instanceof Error ? error.message : "Sign-in link failed",
                  variant: "error",
                });
              }
            })();
          })
        : undefined;

    const unsubscribeOpenSettings =
      typeof window.nomadNative.onOpenSettings === "function"
        ? window.nomadNative.onOpenSettings(() => setSidebarTab("settings"))
        : undefined;

    // Window chrome for this run (native-frame fallback for tiling WMs).
    void (async () => {
      try {
        const config = await window.nomadNative.getNativeFrame();
        setNativeFrameConfig(config);
        setNativeFrameAtBoot(config.enabled);
      } catch {
        // Window controls stay custom; Settings shows a loading state.
      }
    })();

    // Sequential on purpose: the account sync decision needs a known
    // tailnet state (H4d gate), so the tailnet comes up first. Passive
    // read only: an interactive bring-up here would start a Tailscale
    // login (toast + browser hand-off) on every launch for signed-out
    // users — sign-in is voluntary, via the explicit CTA.
    void (async () => {
      // Apply a saved tailnet name before the passive state read, which
      // can bring an already-signed-in node up. This does not start a login.
      if (typeof window.nomadNative.setTailscaleHostname === "function") {
        try {
          await window.nomadNative.setTailscaleHostname(loadAppSettings().tailscaleHostname);
        } catch {
          // The name is still written for the next sidecar start.
        }
      }
      await refreshTailnet(false);
      await refreshSidecarStatus();
      const restored = await restoreAccountSession();
      if (restored) {
        await refreshAccountSessionIfDue();
      }
      const session = accountSessionRef.current;
      if (session) {
        await synchronizeAccountLibrary(session.email, false);
      }
    })();

    const interval = window.setInterval(() => {
      void refreshTailnet(false);
      void refreshSidecarStatus();
    }, 5000);

    return () => {
      window.clearInterval(interval);
      autoReconnectRef.current?.stop();
      unsubscribe();
      unsubscribeAuthCallback?.();
      unsubscribeOpenSettings?.();
    };
  }, [refreshAccountSessionIfDue, refreshSecureStorageStatus, refreshTailnet, refreshSidecarStatus, restoreAccountSession, synchronizeAccountLibrary]);

  // --- Derived state ---
  const selectedPeer = useMemo(
    () => peers.find((peer) => peer.stableId === selectedPeerId),
    [peers, selectedPeerId],
  );

  const selectedMachine = useMemo(
    () => savedMachines.find((machine) => machine.id === selectedMachineId),
    [savedMachines, selectedMachineId],
  );

  // --- Machine loading & editing ---
  function applyMachineSelection(machine: SavedMachine): void {
    setSelectedMachineId(machine.id);
    // Address-only machines have no tailnet device: show their address in
    // the host field instead of selecting a phantom device.
    if (isManualMachine(machine)) {
      setSelectedPeerId("");
      setManualHost(resolveMachineHost(machine, []));
    } else {
      setSelectedPeerId(machine.tailscaleStableId);
      setManualHost("");
    }
    setMachineLabel(machine.label);
    setVncPort(String(machine.vncPort));
    setVncUsername(machine.vncUsername ?? "");
    setSelectedCollectionId(machine.collectionId ?? "");
    setSavePasswordSecurely(machine.credentialMode !== "prompt");
  }

  function handleEditMachine(machine: SavedMachine): void {
    applyMachineSelection(machine);
    setPassword("");
    setSidebarTab("form");
  }

  async function handleDeleteMachine(machine: SavedMachine): Promise<void> {
    // Signed in, account machines live on the server: delete there first so
    // the cache can't resurrect them on the next download. Plain HTTPS —
    // no tailnet needed.
    if (accountSessionRef.current && machine.ownerMode === "account") {
      try {
        await accountClient.deleteDevice(machine.id);
      } catch (error) {
        if (error instanceof AccountApiError && error.status === 401) {
          await handleAccountExpired();
          return;
        }
        setStatus({
          message: `Couldn't delete ${machine.label} from the Nomad account. Kept locally.`,
          variant: "error",
        });
        return;
      }
    }
    setSavedMachines((current) => current.filter((m) => m.id !== machine.id));
    setMachineViewPrefsState((current) => {
      if (!(machine.id in current)) {
        return current;
      }
      const next = { ...current };
      delete next[machine.id];
      return next;
    });

    // Also clean up any stored password
    if (machine.credentialMode === "localSecure") {
      void window.nomadNative.deleteMachinePassword(machine.id).catch(() => {
        // Password cleanup is best-effort
      });
    }

    if (selectedMachineId === machine.id) {
      setSelectedMachineId("");
    }

    setStatus({ message: `Removed ${machine.label}`, variant: "info" });
  }

  function resetForm(): void {
    setSelectedPeerId("");
    setManualHost("");
    setSelectedMachineId("");
    setMachineLabel("");
    setVncPort(String(appSettings.defaultVncPort));
    setVncUsername("");
    setPassword("");
    setSelectedCollectionId("");
    setSavePasswordSecurely(false);
  }

  function handleCreateCollection(name: string): Collection | null {
    const result = createCollection(collections, name);
    if (!result) {
      return null;
    }
    setCollections(result.collections);
    return result.collection;
  }

  function handleDeleteCollection(collection: Collection): void {
    setCollections((current) => deleteCollection(current, collection.id));
    setSavedMachines((current) => {
      let next = current;
      for (const machine of current) {
        if (machine.collectionId === collection.id) {
          next = setMachineCollection(next, machine.id, undefined);
        }
      }
      return next;
    });
    setSelectedCollectionId((current) => (current === collection.id ? "" : current));
    setStatus({ message: `Deleted group "${collection.name}" (machines kept)`, variant: "info" });
  }

  // --- Save machine ---
  async function saveMachine(): Promise<void> {
    // A tailnet device wins; otherwise the typed address makes an
    // address-only (local-first) machine.
    const typedHost = manualHost.trim();
    if (!selectedPeer && !typedHost) {
      setStatus({
        message: tailnetState?.loggedIn
          ? "Pick a tailnet device or enter the machine's address before saving"
          : "Enter the machine's address before saving",
        variant: "error",
      });
      return;
    }

    const portNumber = Number(vncPort);
    if (!Number.isInteger(portNumber) || portNumber <= 0) {
      setStatus({ message: "Enter a valid VNC port before saving", variant: "error" });
      return;
    }

    if (savePasswordSecurely) {
      const next = await refreshSecureStorageStatus();
      if (!next.available) {
        setStatus({
          message: secureStorageUnavailableMessage(next),
          variant: "error",
        });
        return;
      }
    }

    const identity = selectedPeer ? selectedPeer.stableId : manualStableId(typedHost);
    const existingMachine = selectedMachine
      ?? savedMachines.find((machine) => machine.tailscaleStableId === identity && machine.vncPort === portNumber);
    const hadStoredPassword = existingMachine?.credentialMode === "localSecure";
    const hadSyncedPassword = existingMachine?.credentialMode === "cloudSecure";
    const signedIn = accountSessionRef.current !== null;

    let nextCredentialMode: SavedMachine["credentialMode"] = "prompt";
    if (savePasswordSecurely) {
      if (signedIn) {
        // Signed in, secure means synced: the password roams via the account.
        if (password || hadSyncedPassword) {
          nextCredentialMode = "cloudSecure";
        } else if (hadStoredPassword && !password) {
          // Local keyring password exists but was never synced: require it
          // explicitly before switching the mode over to the server.
          setStatus({ message: "Enter the password once to move it into synced storage", variant: "error" });
          return;
        } else {
          setStatus({ message: "Enter a password before enabling secure storage", variant: "error" });
          return;
        }
      } else if (password) {
        nextCredentialMode = "localSecure";
      } else if (hadStoredPassword) {
        nextCredentialMode = "localSecure";
      } else {
        setStatus({ message: "Enter a password before enabling secure local storage", variant: "error" });
        return;
      }
    }

    const nextMachine = selectedPeer
      ? createGuestMachineFromPeer({
          existingMachine,
          peer: selectedPeer,
          label: machineLabel.trim() || selectedPeer.displayName,
          vncPort: portNumber,
          credentialMode: nextCredentialMode,
          vncUsername,
          collectionId: selectedCollectionId || null,
        })
      : createManualMachine({
          existingMachine,
          host: typedHost,
          label: machineLabel.trim() || typedHost,
          vncPort: portNumber,
          credentialMode: nextCredentialMode,
          vncUsername,
          collectionId: selectedCollectionId || null,
        });

    // Signed in, the server is the library: push first, and only cache
    // locally on success — a failed push saves nothing, so the cache can
    // never silently diverge from the account. Plain HTTPS, no tailnet needed.
    if (signedIn) {
      try {
        const view = await pushSavedMachine(
          accountClient,
          { ...nextMachine, ownerMode: "account" },
          collections,
          nextCredentialMode === "cloudSecure" && password ? password : undefined,
        );
        if (nextCredentialMode === "prompt" && hadSyncedPassword) {
          // Mode moved away from synced storage: clear the now-orphaned
          // server credential instead of leaving it behind.
          await accountClient.deleteDeviceCredential(view.id);
        }
        const synced: SavedMachine = {
          ...nextMachine,
          id: view.id,
          ownerMode: "account",
          credentialMode: nextCredentialMode,
          updatedAt: view.updatedAt,
        };
        setSavedMachines((current) => upsertSavedMachine(current, synced));
        setSelectedMachineId(synced.id);
        setMachineLabel(synced.label);
        if (nextCredentialMode === "cloudSecure") {
          setPassword("");
          setSavePasswordSecurely(true);
        }
        setStatus({
          message: `Saved ${synced.label} (synced to Nomad account)`,
          variant: "success",
        });
        setSidebarTab("machines");
      } catch (error) {
        if (error instanceof AccountApiError && error.status === 401) {
          await handleAccountExpired();
          return;
        }
        setStatus({
          message: error instanceof Error
            ? `Couldn't sync ${nextMachine.label}. Saved nothing (${error.message}).`
            : `Couldn't sync ${nextMachine.label}. Saved nothing.`,
          variant: "error",
        });
      }
      return;
    }

    try {
      if (nextCredentialMode === "localSecure" && password) {
        await window.nomadNative.setMachinePassword(nextMachine.id, password);
      } else if (nextCredentialMode === "localSecure" && hadStoredPassword) {
        // Metadata can say "localSecure" while keyring state changes underneath;
        // verify the encrypted password is still actually retrievable.
        const existing = await window.nomadNative.getMachinePassword(nextMachine.id);
        if (!existing) {
          throw new Error("Secure password is unavailable. Re-enter the password and save again.");
        }
      } else if (nextCredentialMode === "prompt" && hadStoredPassword) {
        await window.nomadNative.deleteMachinePassword(nextMachine.id);
      }

      setSavedMachines((current) => upsertSavedMachine(current, nextMachine));
      setSelectedMachineId(nextMachine.id);
      setMachineLabel(nextMachine.label);
      if (nextCredentialMode === "localSecure") {
        setPassword("");
        setSavePasswordSecurely(true);
      }

      setStatus({
        message: `Saved ${nextMachine.label} ${nextCredentialMode === "localSecure" ? "with secure password storage" : "locally"}`,
        variant: "success",
      });

      // Switch back to machines tab on save
      setSidebarTab("machines");
    } catch (error) {
      setStatus({
        message: error instanceof Error ? error.message : "Unable to save the machine password securely",
        variant: "error",
      });
    }
  }

  // --- Password resolution ---
  /** `forcedPassword` is set when connecting from a saved-machine card in "prompt" mode (reuse form or browser prompt). */
  async function resolveSessionPassword(targetMachine: SavedMachine | undefined, forcedPassword?: string): Promise<string> {
    if (forcedPassword !== undefined) {
      return forcedPassword;
    }

    if (password) {
      return password;
    }

    if (targetMachine?.credentialMode === "localSecure") {
      try {
        const storedPassword = await window.nomadNative.getMachinePassword(targetMachine.id);
        if (!storedPassword) {
          throw new Error("No saved password was found for this machine. Enter it again and save.");
        }

        return storedPassword;
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (message.includes("Secure credential storage is unavailable")) {
          const entered = await requestPasswordPrompt(
            "VNC Password",
            `Saved password for "${targetMachine.label}" cannot be read (OS keyring unavailable). Enter the password for this session.`,
          );
          if (entered === null) {
            throw new Error("Connection cancelled");
          }
          return entered;
        }
        throw error;
      }
    }

    if (targetMachine?.credentialMode === "cloudSecure") {
      // Fetching the synced password is a plain HTTPS account call —
      // no tailnet needed.
      const session = accountSessionRef.current;
      if (session) {
        try {
          const synced = await accountClient.getDeviceCredential(targetMachine.id);
          if (synced) {
            return synced;
          }
        } catch (error) {
          if (error instanceof AccountApiError && error.status === 401) {
            await handleAccountExpired();
            throw new Error("Nomad session expired. Signed out. Sign in and reconnect.");
          }
          throw new Error(
            error instanceof Error
              ? `Couldn't fetch the synced password (${error.message})`
              : "Couldn't fetch the synced password",
          );
        }
      }
      // Signed out, or nothing stored server-side: fall back to a prompt.
      const entered = await requestPasswordPrompt(
        "VNC Password",
        session
          ? `No synced password is stored for "${targetMachine.label}". Enter it for this session (or save the machine with secure storage to sync one).`
          : `"${targetMachine.label}" uses a synced password, but you're signed out of the Nomad account. Sign in to fetch it, or enter it for this session.`,
      );
      if (entered === null) {
        throw new Error("Connection cancelled");
      }
      return entered;
    }

    return "";
  }

  /** macOS Screen Sharing often needs the account short name in addition to the VNC password. */
  function resolveSessionVncUsername(targetMachine: SavedMachine | undefined): string | undefined {
    const fromMachine = targetMachine?.vncUsername?.trim();
    if (fromMachine) {
      return fromMachine;
    }
    const fromForm = vncUsername.trim();
    return fromForm || undefined;
  }

  // --- Session management ---
  // Automatic reconnection for transient drops (network flap, VNC server
  // restart). The controller's callbacks only touch refs and state setters,
  // so the lazily created instance stays valid for the component's lifetime.
  const reconnectInFlightRef = useRef(false);
  const autoReconnectRef = useRef<SessionReconnectController | null>(null);
  if (!autoReconnectRef.current) {
    autoReconnectRef.current = new SessionReconnectController({
      attempt: () => runReconnectAttempt(),
      onExhausted: () => {
        // Retry budget spent: surface the manual "Connection lost" overlay
        // with an honest diagnosis (peer offline vs. VNC server dead).
        const session = activeSessionRef.current;
        const machine = session?.machineId
          ? savedMachinesRef.current.find((entry) => entry.id === session.machineId)
          : undefined;
        const presence = machine ? getMachinePresence(machine, peersRef.current) : undefined;
        const target = session ? `${session.host}:${session.port}` : null;
        setViewerConnectionLost(true);
        if (machine && presence?.kind === "offline") {
          const suffix = formatLastSeenSuffix(presence.peer?.lastSeen);
          setStatus({
            message: `Couldn't reconnect to "${machine.label}". It looks offline now${suffix ? ` (${suffix})` : ""}. Reconnect to retry.`,
            variant: "error",
          });
        } else if (machine && target) {
          setStatus({
            message: `Couldn't reconnect to "${machine.label}" after ${AUTO_RECONNECT_MAX_ATTEMPTS} tries. Its VNC server at ${target} may have stopped. Reconnect to retry.`,
            variant: "error",
          });
        } else if (target) {
          setStatus({
            message: `Couldn't reconnect to ${target} after ${AUTO_RECONNECT_MAX_ATTEMPTS} tries. The VNC server may have stopped. Reconnect to retry.`,
            variant: "error",
          });
        } else {
          setStatus({ message: "Couldn't reconnect. Reconnect to retry.", variant: "error" });
        }
      },
      onAttemptScheduled: (attempt) => {
        // Keep the manual overlay hidden while retries are in flight; the
        // status line carries the progress.
        setViewerConnectionLost(false);
        setStatus({
          message: `Connection lost. Retrying (${attempt}/${AUTO_RECONNECT_MAX_ATTEMPTS})…`,
          variant: "connecting",
        });
      },
      onNetworkOffline: () => {
        // The OS network dropped: pause retries without burning the budget.
        // The loop resumes with a fresh budget when the network returns.
        setViewerConnectionLost(false);
        setStatus({
          message: "You're offline. Retrying when the network returns…",
          variant: "connecting",
        });
      },
    });
  }

  // Pause/resume the retry loop with the OS network. This catches the common
  // "tailnet path died" case (wifi drop, sleep/wake) that tsnet's own
  // logged-in state can't report: tsnet stays "Running" while the path is
  // down, and retries would otherwise burn the budget blaming the VNC server.
  useEffect(() => {
    const handleOffline = (): void => {
      autoReconnectRef.current?.noteNetworkOffline();
    };
    const handleOnline = (): void => {
      autoReconnectRef.current?.noteNetworkOnline();
    };
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  async function disconnectSession(nextMessage = "Session closed"): Promise<void> {
    autoReconnectRef.current?.stop();
    if (!activeSession) {
      return;
    }

    const sessionId = activeSession.sessionId;
    activeSessionIdRef.current = null;
    setActiveSession(null);
    setViewerHtml("");
    setViewerConnectionLost(false);
    setIsReconnecting(false);
    setSessionHint("Session ended. Choose another machine or reconnect.");

    // A fullscreen window with no session is a dead end — drop out of
    // fullscreen so the sidebar and window chrome come back.
    try {
      if (await window.nomadNative.getFullscreen()) {
        await window.nomadNative.toggleFullscreen();
      }
    } catch {
      // fullscreen exit is best-effort
    }

    try {
      await window.nomadNative.stopVncSession(sessionId);
      setStatus({ message: nextMessage, variant: "info" });
    } catch (error) {
      setStatus({
        message: error instanceof Error ? error.message : "Unable to stop VNC session",
        variant: "error",
      });
    }
  }

  const handleViewerState = useCallback((state: ViewerConnectionState): void => {
    if (state === "connected") {
      // A completed RFB handshake means the session is healthy: the retry
      // loop (if any) is done and its budget resets.
      autoReconnectRef.current?.noteConnected();
      setViewerConnectionLost(false);
      setViewerLive(true);
      sessionEverLiveRef.current = true;
      setViewerNeverConnected(false);
      void authRecoveryRef.current.onConnected();
      return;
    }
    setViewerLive(false);
    if (state === "authFailed") {
      // Retrying a rejected password can't succeed (and gets clients
      // blacklisted by many servers): stop the loop and ask instead.
      autoReconnectRef.current?.stop();
      void authRecoveryRef.current.onAuthFailed();
      return;
    }
    if (state === "disconnected" && activeSessionIdRef.current !== null) {
      // The TCP dial to the VNC target happens lazily when noVNC connects,
      // so a drop here means either the host went away or its VNC server did.
      const session = activeSessionRef.current;
      const machine = session?.machineId
        ? savedMachinesRef.current.find((entry) => entry.id === session.machineId)
        : undefined;
      const presence = machine ? getMachinePresence(machine, peersRef.current) : undefined;
      if (machine && presence?.kind === "offline") {
        // The peer is gone: retrying is pointless, go straight to manual.
        autoReconnectRef.current?.stop();
        const suffix = formatLastSeenSuffix(presence.peer?.lastSeen);
        setViewerConnectionLost(true);
        setStatus({
          message: `Connection to "${machine.label}" lost. It looks offline now${suffix ? ` (${suffix})` : ""}.`,
          variant: "error",
        });
        return;
      }
      if (!sessionEverLiveRef.current && session) {
        // Never got through: retrying the same address won't help, so say
        // what's wrong right away and let the user retry when ready.
        autoReconnectRef.current?.stop();
        setViewerNeverConnected(true);
        setViewerConnectionLost(true);
        setStatus({
          message: `Couldn't connect to ${session.label}`,
          variant: "error",
        });
        return;
      }
      // Transient-looking drop: retry with backoff. The manual "Connection
      // lost" overlay only appears if the retry budget is exhausted. Each
      // viewer-level failure counts against the same budget — only a
      // successful "connected" resets it.
      autoReconnectRef.current?.noteDisconnected();
    }
  }, []);

  /**
   * Wrong-password recovery. The server rejected the password: ask for a
   * new one and reconnect with it; cancelling ends the session. When the new
   * password gets through and the machine keeps its password in the local
   * keyring, the saved copy is updated so the next connect just works.
   * Held in a ref because the viewer-state callback is memoized once.
   */
  const pendingPasswordUpdateRef = useRef<{ machineId: string; password: string } | null>(null);
  const authRecoveryRef = useRef({ onAuthFailed: async () => {}, onConnected: async () => {} });
  authRecoveryRef.current = {
    onAuthFailed: async () => {
      const session = activeSessionRef.current;
      if (!session) {
        return;
      }
      pendingPasswordUpdateRef.current = null;
      setStatus({ message: `"${session.label}" rejected the password`, variant: "error" });
      const entered = await requestPasswordPrompt(
        "Wrong Password",
        `"${session.label}" didn't accept that password. Enter it again to reconnect.`,
        "Reconnect",
      );
      if (entered === null || activeSessionIdRef.current !== session.sessionId) {
        if (activeSessionIdRef.current === session.sessionId) {
          await disconnectSession();
        }
        return;
      }
      const updated: ActiveSession = { ...session, password: entered || undefined };
      activeSessionRef.current = updated;
      setActiveSession(updated);
      if (session.machineId && entered) {
        pendingPasswordUpdateRef.current = { machineId: session.machineId, password: entered };
      }
      setStatus({ message: `Reconnecting to ${session.label}...`, variant: "connecting" });
      try {
        await runReconnectAttempt();
      } catch (error) {
        setStatus({
          message: error instanceof Error ? error.message : "Unable to reconnect the VNC session",
          variant: "error",
        });
      }
    },
    onConnected: async () => {
      const pending = pendingPasswordUpdateRef.current;
      pendingPasswordUpdateRef.current = null;
      if (!pending) {
        return;
      }
      const machine = savedMachinesRef.current.find((entry) => entry.id === pending.machineId);
      if (machine?.credentialMode === "localSecure") {
        try {
          await window.nomadNative.setMachinePassword(machine.id, pending.password);
          setStatus({ message: `Updated the saved password for ${machine.label}`, variant: "success" });
        } catch {
          setStatus({
            message: `Connected, but couldn't update the saved password for ${machine.label}. Edit the machine to save it.`,
            variant: "error",
          });
        }
      } else if (machine?.credentialMode === "cloudSecure") {
        setStatus({
          message: `Connected. Edit ${machine.label} and save to update its synced password.`,
          variant: "info",
        });
      }
    },
  };

  /**
   * Make-before-break reconnect: start the replacement proxy session first so
   * a failed attempt keeps the (dead) session object intact for another retry.
   * Throws on failure; callers decide whether to retry or surface the error.
   */
  async function runReconnectAttempt(): Promise<void> {
    const previous = activeSessionRef.current;
    if (!previous || reconnectInFlightRef.current) {
      throw new Error("No session to reconnect");
    }

    reconnectInFlightRef.current = true;
    setIsReconnecting(true);
    try {
      const session = await window.nomadNative.startVncSession({
        host: previous.host,
        port: previous.port,
        sessionToken: crypto.randomUUID(),
        direct: previous.direct,
      });

      if (activeSessionIdRef.current === null) {
        // The user disconnected while we were dialing: drop the replacement
        // instead of resurrecting the session.
        try {
          await window.nomadNative.stopVncSession(session.sessionId);
        } catch {
          // Best-effort cleanup.
        }
        return;
      }

      // Stopped once the new viewer has mounted (effect on sessionKey). Stopping
      // it now would let the old, still-mounted viewer report "disconnected"
      // and start the auto-retry loop for a session that is being replaced.
      supersededSessionIdRef.current = previous.sessionId;

      if (previous.machineId) {
        setSavedMachines((current) => touchSavedMachineConnection(current, previous.machineId as string));
      }

      const next: ActiveSession = {
        ...previous,
        sessionId: session.sessionId,
        wsUrl: session.wsUrl,
      };
      activeSessionIdRef.current = next.sessionId;
      setActiveSession(next);
      setViewerHtml(
        createViewerHtml({
          wsUrl: session.wsUrl,
          password: previous.password,
          username: previous.vncUsername,
          bootstrapModuleUrl: new URL("./vendor/novnc/core/rfb.js", window.location.href).toString(),
          bootstrapScriptUrl: new URL(viewerBootstrapUrl, window.location.href).toString(),
          inputModuleUrl: new URL(viewerInputUrl, window.location.href).toString(),
          desktop: true,
          fitToScreen: true,
        }),
      );
      // Force the iframe to remount even when the proxy URL is unchanged.
      setSessionKey((key) => key + 1);
    } finally {
      reconnectInFlightRef.current = false;
      setIsReconnecting(false);
    }
  }

  /** One-click reconnect: establish a fresh proxy session with the same parameters. */
  async function reconnectSession(): Promise<void> {
    autoReconnectRef.current?.stop();
    const previous = activeSessionRef.current;
    if (!previous || reconnectInFlightRef.current) {
      return;
    }

    setStatus({ message: `Reconnecting to ${previous.label}...`, variant: "connecting" });
    try {
      await runReconnectAttempt();
    } catch (error) {
      setStatus({
        message: error instanceof Error ? error.message : "Unable to reconnect the VNC session",
        variant: "error",
      });
    }
  }

  async function connect(machineOverride?: SavedMachine): Promise<void> {
    if (activeSession) {
      setStatus({ message: "Disconnect the current session before starting another one", variant: "error" });
      return;
    }

    const fallbackMachine = selectedPeer
      ? savedMachines.find((machine) => machine.tailscaleStableId === selectedPeer.stableId && machine.vncPort === Number(vncPort))
      : undefined;

    // A typed address that matches a saved machine is that machine: the
    // session updates its last-connected time instead of looking brand new.
    const typedHost = machineOverride ? "" : manualHost.trim().toLowerCase();
    const addressMatch = !machineOverride && !selectedMachine && typedHost
      ? savedMachines.find((machine) => {
          const host = (machine.dnsName ?? machine.lastKnownTailnetIp ?? "").trim().toLowerCase();
          return host === typedHost && machine.vncPort === Number(vncPort);
        })
      : undefined;

    const targetMachine = machineOverride ?? selectedMachine ?? fallbackMachine ?? addressMatch;
    const portNumber = machineOverride?.vncPort ?? Number(vncPort);
    if (!Number.isInteger(portNumber) || portNumber <= 0) {
      setStatus({ message: "Enter a valid VNC port before connecting", variant: "error" });
      return;
    }

    // Fail fast on a peer the tailnet reports as offline — its cached
    // address won't route, so don't bother with password prompts.
    const targetPeer = targetMachine
      ? peers.find((peer) => peer.stableId === targetMachine.tailscaleStableId)
      : selectedPeer;
    const targetLabel = targetMachine?.label ?? selectedPeer?.displayName ?? "This machine";
    if (targetPeer && !targetPeer.online) {
      const suffix = formatLastSeenSuffix(targetPeer.lastSeen);
      setStatus({
        message: `"${targetLabel}" looks offline${suffix ? ` (${suffix})` : ""}. Power it on or check Tailscale, then retry.`,
        variant: "error",
      });
      return;
    }

    // Manual host is a connect-time override for form-initiated connects
    // (card clicks always carry a machineOverride and ignore it).
    const manualHostValue = machineOverride ? "" : manualHost.trim();
    // Typed addresses and address-only saved machines dial on the OS
    // network (local-first); tailnet devices need the tailnet.
    const directDial = manualHostValue !== "" || (targetMachine !== undefined && isManualMachine(targetMachine));
    const host = manualHostValue
      ? manualHostValue
      : targetMachine
        ? resolveMachineHost(targetMachine, peers)
        : selectedPeer?.dnsName ?? selectedPeer?.tailnetIps[0] ?? "";

    if (!host) {
      setStatus({
        message: targetMachine
          ? "Unable to resolve the saved machine host. Refresh devices, choose an online peer, or enter a manual host."
          : "Choose a peer or enter a manual host first",
        variant: "error",
      });
      return;
    }

    // Saved list "Prompt" mode: the password field is on the form, so one-click connect must ask here or reuse the form if this machine is already open.
    let cardPromptPassword: string | undefined;
    if (machineOverride?.credentialMode === "prompt") {
      const reuseForm =
        selectedMachineId === machineOverride.id && password.trim() !== "";
      if (reuseForm) {
        cardPromptPassword = password;
      } else {
        const entered = await requestPasswordPrompt(
          "VNC Password",
          `Enter the password for "${machineOverride.label}". Leave blank if the server does not require one.`,
          "Connect",
        );
        if (entered === null) {
          setStatus({ message: "Connection cancelled", variant: "info" });
          return;
        }
        cardPromptPassword = entered;
      }
    }

    if (machineOverride) {
      applyMachineSelection(machineOverride);
    }

    const label = (targetMachine?.label ?? machineLabel.trim()) || selectedPeer?.displayName || host;

    setStatus({ message: `Connecting to ${label}...`, variant: "connecting" });
    setConnectingMachineId(targetMachine?.id ?? null);
    setSessionHint(`Launching a direct VNC session to ${label}.`);

    try {
      const sessionPassword = await resolveSessionPassword(targetMachine, cardPromptPassword);
      const sessionVncUsername = resolveSessionVncUsername(targetMachine);
      const session = await window.nomadNative.startVncSession({
        host,
        port: portNumber,
        sessionToken: crypto.randomUUID(),
        // A typed address is the local-first path: the sidecar dials it on
        // the OS network even when the tailnet isn't up.
        direct: directDial,
      });

      if (targetMachine) {
        setSavedMachines((current) => touchSavedMachineConnection(current, targetMachine.id));
      }

      activeSessionIdRef.current = session.sessionId;
      sessionEverLiveRef.current = false;
      setViewerNeverConnected(false);
      setViewerLive(false);
      setActiveSession({
        sessionId: session.sessionId,
        wsUrl: session.wsUrl,
        password: sessionPassword || undefined,
        vncUsername: sessionVncUsername,
        machineId: targetMachine?.id,
        label,
        host,
        port: portNumber,
        direct: directDial,
      });
      setViewerHtml(
        createViewerHtml({
          wsUrl: session.wsUrl,
          password: sessionPassword || undefined,
          username: sessionVncUsername,
          bootstrapModuleUrl: new URL("./vendor/novnc/core/rfb.js", window.location.href).toString(),
          bootstrapScriptUrl: new URL(viewerBootstrapUrl, window.location.href).toString(),
          inputModuleUrl: new URL(viewerInputUrl, window.location.href).toString(),
          desktop: true,
          fitToScreen: true,
        }),
      );
      setViewerConnectionLost(false);
      setIsReconnecting(false);
      setSessionKey((key) => key + 1);
      setStatus({ message: "Idle", variant: "info" });
    } catch (error) {
      // startVncSession only brings up the localhost proxy — the VNC dial
      // itself happens later — so a failure here is a tailnet-path problem,
      // not a "VNC server down" verdict.
      const reason = error instanceof Error ? error.message : "Unable to start VNC session";
      setStatus({
        message: host
          ? `Couldn't open a VNC path to ${host}:${portNumber} through the tailnet (${reason}). The machine may be offline, or Tailscale may still be connecting. Check that it appears online, then retry.`
          : reason,
        variant: "error",
      });
    } finally {
      setConnectingMachineId(null);
    }
  }

  // --- Render ---
  const showSidebar = !isFullscreen || !activeSession;

  // Signed-out pending uploads: a returning account user with local machines
  // that haven't been uploaded for their email yet.
  const accountSyncSnapshot = loadSyncState();
  const pendingUploadEmail =
    !accountSession
    && accountSyncSnapshot.lastAccountEmail
    && accountSyncSnapshot.uploadedForEmail !== accountSyncSnapshot.lastAccountEmail
      ? accountSyncSnapshot.lastAccountEmail
      : null;
  const pendingUploadCount = pendingUploadEmail ? savedMachines.length : 0;

  // Settings and Account read best full-width: with no live session they
  // open in the main pane (the sidebar keeps the machine list). During a
  // session they stay in the sidebar so the remote desktop isn't replaced.
  const panelInMain = !activeSession && (sidebarTab === "account" || sidebarTab === "settings");
  const accountPanel = (
    <AccountPanel
      session={accountSession}
      baseUrl={accountBaseUrl}
      lastSyncAt={lastAccountSyncAt}
      pendingUploadCount={pendingUploadCount}
      pendingUploadEmail={pendingUploadEmail}
      onBaseUrlChange={handleAccountBaseUrlChange}
      onRequestLink={handleRequestMagicLink}
      onConsumeLink={handleConsumeMagicLink}
      onSignOut={handleAccountSignOut}
      onDeleteAccount={handleAccountDelete}
      onSyncNow={handleSyncNow}
      onNotice={(message, variant) => setStatus({ message, variant })}
    />
  );
  const settingsPanel = (
    <SettingsPanel
      settings={appSettings}
      secureStorage={secureStorageStatus}
      onChange={(partial) => updateAppSettings(partial)}
      nativeFrame={nativeFrameConfig}
      nativeFrameNeedsRestart={
        nativeFrameConfig !== null
        && nativeFrameAtBoot !== null
        && nativeFrameConfig.enabled !== nativeFrameAtBoot
      }
      onNativeFrameChange={(enabled) => void handleNativeFrameChange(enabled)}
      onRelaunch={() => void handleRelaunch()}
      onTailscaleHostname={async (name) => {
        const result = await window.nomadNative.setTailscaleHostname(name);
        updateAppSettings({
          tailscaleHostname: name.trim() === "" ? "" : result.hostname,
        });
        return result;
      }}
    />
  );
  const machineList = (
    <QuickConnect
      machines={savedMachines}
      peers={peers}
      activeMachineId={activeSession?.machineId}
      connectingMachineId={connectingMachineId ?? undefined}
      collections={collections}
      sharedDevices={sharedDevices}
      onConnect={(machine) => void connect(machine)}
      onEdit={handleEditMachine}
      onDelete={handleDeleteMachine}
      onShare={(machine) => void openShareDialog(machine)}
      isAccountMachine={(machine) =>
        machine.ownerMode === "account"
        && accountSessionRef.current !== null
        && tailnetState?.loggedIn === true
      }
      onSwitchToForm={() => setSidebarTab("form")}
      onDeleteCollection={handleDeleteCollection}
    />
  );

  return (
    <div className="window-shell">
      {passwordModal ? (
        <PasswordPromptModal
          title={passwordModal.title}
          body={passwordModal.body}
          submitLabel={passwordModal.submitLabel}
          onSubmit={(value) => completePasswordPrompt(value)}
          onCancel={() => completePasswordPrompt(null)}
        />
      ) : null}
      {sharingMachine ? (
        <ShareDialog
          machineLabel={sharingMachine.label}
          shares={machineShares}
          loadingShares={loadingShares}
          onGrant={handleGrantShare}
          onRekey={handleRekeyShare}
          onClearKey={handleClearShareKey}
          onRevoke={handleRevokeShare}
          onNotice={(message, variant) => setStatus({ message, variant })}
          onClose={() => setSharingMachine(null)}
        />
      ) : null}
      <main className={`shell ${isFullscreen && activeSession ? "shell--fullscreen" : ""} ${sidebarCollapsed ? "shell--sidebar-collapsed" : ""}`}>
        {!isFullscreen && nativeFrameAtBoot !== true && (
          <div className="viewer-topbar">
            <div className="viewer-topbar__meta" />

            <div className="viewer-topbar__actions">
              <button
                type="button"
                className="window-control"
                onClick={() => void handleMinimizeWindow()}
                aria-label="Minimize window"
                title="Minimize"
              >
                <WindowMinimizeIcon />
              </button>
              <button
                type="button"
                className="window-control"
                onClick={() => void handleToggleMaximizeWindow()}
                aria-label={isMaximized ? "Restore window" : "Maximize window"}
                title={isMaximized ? "Restore" : "Maximize"}
              >
                {isMaximized ? <WindowRestoreIcon /> : <WindowMaximizeIcon />}
              </button>
              <button
                type="button"
                className="window-control window-control--close"
                onClick={() => void handleCloseWindow()}
                aria-label="Close window"
                title="Close"
              >
                <WindowCloseIcon />
              </button>
            </div>
          </div>
        )}

        {!sidebarCollapsed && activeSession && showSidebar && (
          <button
            className="btn-collapse-float"
            onClick={() => setSidebarCollapsed(true)}
            title="Collapse Sidebar"
          >
            {isVertical ? (
              <ChevronUpIcon style={{ width: 14, height: 14 }} />
            ) : (
              <ChevronLeftIcon style={{ width: 14, height: 14 }} />
            )}
          </button>
        )}

        {sidebarCollapsed && (
          <button
            className="btn-expand-float"
            onClick={() => setSidebarCollapsed(false)}
            title="Expand Sidebar"
          >
            {isVertical ? (
              <ChevronDownIcon style={{ width: 14, height: 14 }} />
            ) : (
              <ChevronRightIcon style={{ width: 14, height: 14 }} />
            )}
          </button>
        )}

        {showSidebar && (
          <section className={`sidebar ${sidebarCollapsed ? "sidebar--collapsed" : ""}`}>
            {!sidebarCollapsed && (
              <>
                <SidebarHeader
                  tailnetState={tailnetState}
                  isRefreshing={isRefreshing}
                  activeSessionLabel={activeSession?.label}
                  sessionState={viewerLive ? "live" : viewerConnectionLost ? "down" : "connecting"}
                  onSignOut={() => void handleSignOut()}
                  onResetIdentity={() => void handleResetIdentity()}
                />

                {sidecarStatus && !sidecarStatus.running && sidecarStatus.message && (
                  <div className="sidecar-banner" role="alert">
                    <div className="sidecar-banner__title">NomadVNC Backend Isn't Running</div>
                    <p className="sidecar-banner__message">{sidecarStatus.message}</p>
                    <p className="sidecar-banner__hint">
                      Nothing can connect until the backend starts. Reinstalling NomadVNC
                      usually fixes a missing backend; if you run from source, build the
                      sidecar into <code>go-core/bin</code> (or set{" "}
                      <code>NOMADVNC_SIDECAR_PATH</code>) and retry.
                    </p>
                    <div className="sidecar-banner__actions">
                      <button className="btn btn--primary btn--sm" onClick={() => void retrySidecar()}>
                        Retry
                      </button>
                    </div>
                  </div>
                )}

                {renderKeyExpiryBanner()}

                <div className="sidebar-tabs">
                  <button
                    className={`sidebar-tab ${sidebarTab === "machines" ? "sidebar-tab--active" : ""}`}
                    onClick={() => setSidebarTab("machines")}
                  >
                    Machines
                  </button>
                  <button
                    className={`sidebar-tab ${sidebarTab === "form" ? "sidebar-tab--active" : ""}`}
                    onClick={() => {
                      resetForm();
                      setSidebarTab("form");
                    }}
                  >
                    {sidebarTab === "form" && selectedMachineId ? "Editing" : "+ New"}
                  </button>
                  <button
                    className={`sidebar-tab ${sidebarTab === "account" ? "sidebar-tab--active" : ""}`}
                    onClick={() => setSidebarTab("account")}
                    title={accountSession ? `Nomad Account (${accountSession.email})` : "Nomad Account (Local Mode)"}
                  >
                    {accountSession ? "Account ✓" : "Account"}
                  </button>
                  <button
                    className={`sidebar-tab ${sidebarTab === "settings" ? "sidebar-tab--active" : ""}`}
                    onClick={() => setSidebarTab("settings")}
                    title="App Settings and Diagnostics"
                  >
                    Settings
                  </button>
                </div>

                <div className="sidebar-content">
                  {sidebarTab === "account" && !panelInMain ? (
                    accountPanel
                  ) : sidebarTab === "settings" && !panelInMain ? (
                    settingsPanel
                  ) : sidebarTab === "machines" || panelInMain ? (
                    machineList
                  ) : (
                    <ConnectionForm
                      peers={peers}
                      selectedPeerId={selectedPeerId}
                      machineLabel={machineLabel}
                      vncPort={vncPort}
                      vncUsername={vncUsername}
                      password={password}
                      collections={collections}
                      selectedCollectionId={selectedCollectionId}
                      savePasswordSecurely={savePasswordSecurely}
                      secureStorageAvailable={secureStorageAvailable}
                      secureStorageHint={secureStorageHint}
                      isRefreshing={isRefreshing}
                      isLoggedIn={tailnetState?.loggedIn ?? false}
                      isEditing={!!selectedMachineId}
                      manualHost={manualHost}
                      onPeerChange={(peerId) => {
                        setSelectedPeerId(peerId);
                        // A picked peer wins over a stale manual entry.
                        if (peerId) {
                          setManualHost("");
                        }
                      }}
                      onManualHostChange={setManualHost}
                      onMachineLabelChange={setMachineLabel}
                      onVncPortChange={setVncPort}
                      onVncUsernameChange={setVncUsername}
                      onPasswordChange={setPassword}
                      onCollectionChange={setSelectedCollectionId}
                      onCreateCollection={handleCreateCollection}
                      onSavePasswordSecurelyChange={(checked) => void handleSavePasswordSecurelyChange(checked)}
                      onRefresh={() => refreshTailnet(true)}
                      onSave={saveMachine}
                      onConnect={() => void connect()}
                      onCancel={() => setSidebarTab("machines")}
                    />
                  )}
                </div>
                <StatusToast
                  message={status.message}
                  variant={status.variant}
                  onDismiss={() => setStatus({ message: "Idle", variant: "info" })}
                />
              </>
            )}
          </section>
        )}

        <section className={`viewer ${isFullscreen && activeSession ? "viewer--fullscreen" : ""}`}>
          <div className={`viewer-body ${isFullscreen && activeSession ? "viewer-body--fullscreen" : ""}`}>
            {panelInMain ? (
              <div className="main-panel">
                <div className="main-panel__inner">
                  {sidebarTab === "account" ? accountPanel : settingsPanel}
                </div>
              </div>
            ) : activeSession ? (
              <ViewerPanel
                session={activeSession}
                viewerHtml={viewerHtml}
                isFullscreen={isFullscreen}
                sessionKey={sessionKey}
                connectionLost={viewerConnectionLost}
                neverConnected={viewerNeverConnected}
                isReconnecting={isReconnecting}
                viewPrefsKey={activeSession.machineId ?? activeSession.sessionId}
                initialViewPrefs={getMachineViewPrefs(
                  machineViewPrefs,
                  activeSession.machineId,
                  defaultViewPrefsFromSettings(appSettings),
                )}
                connectionPath={connectionPath}
                onLinkStalled={() => resampleConnectionPathRef.current()}
                onViewPrefsChange={(prefs) => {
                  if (!activeSession.machineId) {
                    return;
                  }
                  setMachineViewPrefsState((current) =>
                    setMachineViewPrefs(current, activeSession.machineId as string, prefs),
                  );
                }}
                onDisconnect={() => void disconnectSession()}
                onReconnect={() => void reconnectSession()}
                onViewerState={handleViewerState}
                onCredentialsRequired={() =>
                  setStatus({
                    message:
                      "Server asked for more credentials (often macOS Screen Sharing). Add your Mac account short name in VNC username, save the machine, and reconnect.",
                    variant: "error",
                  })
                }
                onToggleFullscreen={() => void handleToggleFullscreen()}
                onRefocusViewer={() => {
                  // Small delay to let toolbar close before refocusing the canvas
                  setTimeout(() => {
                    const iframe = document.querySelector<HTMLIFrameElement>(".viewer-surface iframe");
                    iframe?.contentWindow?.postMessage({ type: "focus" }, "*");
                  }, 100);
                }}
              />
            ) : (
              <ViewerPlaceholder
                tailnetState={tailnetState}
                hasMachines={savedMachines.length > 0}
                hasAccount={accountSession !== null}
                sessionHint={sessionHint}
                isSigningIn={isRefreshing}
                onSignIn={() => void refreshTailnet(true)}
                onOpenAccount={() => setSidebarTab("account")}
                onSelectLocalMode={() => {
                  setStatus({ message: "Local mode active: machines stored securely on this device", variant: "info" });
                }}
                onAddMachine={() => {
                  resetForm();
                  setSidebarTab("form");
                }}
                onOpenSettings={() => setSidebarTab("settings")}
                formOpen={sidebarTab === "form"}
              />
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
