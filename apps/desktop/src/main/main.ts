import { app, BrowserWindow, clipboard, ipcMain, Menu, nativeTheme, net, safeStorage, session, shell, type MenuItemConstructorOptions } from "electron";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { SecureStorageStatus, UpdatePrefs, UpdateStatus, WindowState } from "@nomadvnc/platform-contracts";
import { performAccountRequest } from "./accountHttp";
import { buildApplicationMenuTemplate } from "./appMenu";
import { getRendererCsp } from "./csp";
import { DesktopCredentialStore } from "./credentialStore";
import {
  extractAuthCallbackToken,
  findAuthCallbackUrl,
  registerAuthCallbackProtocol,
  watchAuthCallbackUrls,
} from "./deepLink";
import {
  resolveCredentialStorePath,
  resolvePreloadPath,
  resolveRendererEntryUrl,
  resolveSidecarBinaryPath,
  resolveSidecarStateDir,
  resolveWindowConfigPath,
  resolveWindowIconPath,
} from "./paths";
import { SidecarManager } from "./sidecarManager";
import { enforceSingleInstance } from "./singleInstance";
import { UpdateManager } from "./updater";
import { isAppNavigation, isSafeExternalUrl } from "./navigation";
import { resolveWindowsUninstallerPath, WINDOWS_APP_USER_MODEL_ID } from "./windowsInstall";

let sidecar: SidecarManager;
let credentialStore: DesktopCredentialStore;
let updateManager: UpdateManager;
let mainWindow: BrowserWindow | null = null;
/** OS-keyring slot for the Nomad account JWT (namespaced, never a machine id). */
const ACCOUNT_TOKEN_KEY = "nomad:account-token";
/** Tracks the last seen login state so approval-in-browser refocuses the app once. */
let tailnetWasLoggedIn = false;

function tailscaleHostnameFile(): string {
  return path.join(app.getPath("userData"), "tailscale-hostname.txt");
}

function readTailscaleHostname(): string {
  try {
    return fs.readFileSync(tailscaleHostnameFile(), "utf8").trim();
  } catch {
    return "";
  }
}

function writeTailscaleHostname(name: string): void {
  const file = tailscaleHostnameFile();
  const trimmed = name.trim();
  if (trimmed === "") {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, trimmed, "utf8");
}
/** Set once the renderer finishes loading so deep-link tokens aren't lost. */
let rendererReady = false;
/** Deep-link token that arrived before the renderer was ready to take it. */
let pendingAuthToken: string | null = null;
/** Settings was requested from the menu before the renderer could show it. */
let pendingOpenSettings = false;

if (process.platform === "linux") {
  const passwordStore = process.env.NOMADVNC_PASSWORD_STORE?.trim();
  if (passwordStore) {
    app.commandLine.appendSwitch("password-store", passwordStore);
  }
}

app.setName("NomadVNC");
if (process.platform === "win32") {
  app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
}
// Single-instance lock: a second launch would spawn a second sidecar over
// the same tsnet state dir, risking identity/state corruption. The second
// process quits here; the primary instance focuses its window instead.
const isPrimaryInstance = enforceSingleInstance(app, () => mainWindow);

// Magic-link deep links (nomadvnc://auth/callback?token=...): register the
// scheme with the OS and route incoming URLs to the renderer, which consumes
// the token exactly like a pasted link.
registerAuthCallbackProtocol(app, {
  execPath: process.execPath,
  mainEntry: typeof process.argv[1] === "string" ? path.resolve(process.argv[1]) : "",
  isDefaultApp: process.defaultApp,
});
watchAuthCallbackUrls(app, handleAuthCallbackUrl);

/** Menu bar Settings: show the window, then ask the renderer to open Settings. */
function requestOpenSettings(): void {
  if (!app.isReady()) {
    pendingOpenSettings = true;
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingOpenSettings = true;
    mainWindow = createWindow();
    return;
  }
  focusMainWindow();
  mainWindow.show();
  if (rendererReady) {
    pendingOpenSettings = false;
    mainWindow.webContents.send("nomadvnc:open-settings");
  } else {
    pendingOpenSettings = true;
  }
}

function focusMainWindow(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  }
}

function sendAuthCallbackToRenderer(token: string): void {
  if (mainWindow && !mainWindow.isDestroyed() && rendererReady) {
    mainWindow.webContents.send("nomadvnc:auth-callback", { token });
  } else {
    pendingAuthToken = token;
  }
}

/** The OS delivered a magic-link deep link: focus and hand the token to the renderer. */
function handleAuthCallbackUrl(url: string): void {
  const token = extractAuthCallbackToken(url);
  if (!token) {
    return;
  }
  focusMainWindow();
  sendAuthCallbackToRenderer(token);
}

/** Opens http(s) links in the system browser; anything else (file:, smb:, custom schemes) is dropped. */
function openExternalSafely(url: string): void {
  if (isSafeExternalUrl(url)) {
    void shell.openExternal(url);
  } else {
    writeDevLog("blocked-external-url", { url });
  }
}

function writeDevLog(message: string, details?: unknown): void {
  if (app.isPackaged) {
    return;
  }

  const logPath = path.join(app.getPath("userData"), "desktop-startup.log");
  const entry = `[${new Date().toISOString()}] ${message}${details ? ` ${JSON.stringify(details)}` : ""}\n`;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, entry);
}

function getWindowState(window: BrowserWindow): WindowState {
  return {
    isFullScreen: window.isFullScreen(),
    isMaximized: window.isMaximized(),
  };
}

function broadcastWindowState(window: BrowserWindow): void {
  window.webContents.send("nomadvnc:windowState", getWindowState(window));
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 480,
    minHeight: 480,
    frame: resolveNativeFrame().enabled,
    icon: resolveWindowIconPath(),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#080C12" : "#F2F4F8",
    webPreferences: {
      preload: resolvePreloadPath(),
      contextIsolation: true,
      // The preload only needs contextBridge + ipcRenderer, so it runs
      // sandboxed; clipboard access goes through main-process IPC.
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });

  window.setMenuBarVisibility(false);

  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: "deny" };
  });
  // The window holds the privileged bridge (passwords, account token), so
  // it must never navigate away from the app's own entry document.
  const entryUrl = resolveRendererEntryUrl();
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAppNavigation(url, entryUrl)) {
      event.preventDefault();
      openExternalSafely(url);
    }
  });

  void window.loadURL(resolveRendererEntryUrl());
  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    console.error("NomadVNC renderer failed to load", { errorCode, errorDescription });
    writeDevLog("renderer-failed-load", { errorCode, errorDescription });
  });
  window.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    console.log("NomadVNC renderer console", { level, message, line, sourceId });
    writeDevLog("renderer-console", { level, message, line, sourceId });
  });
  window.webContents.on("did-finish-load", () => {
    writeDevLog("renderer-finished-load");
    broadcastWindowState(window);
    rendererReady = true;
    if (pendingAuthToken) {
      const token = pendingAuthToken;
      pendingAuthToken = null;
      window.webContents.send("nomadvnc:auth-callback", { token });
    }
    if (pendingOpenSettings) {
      pendingOpenSettings = false;
      window.webContents.send("nomadvnc:open-settings");
    }
    void window.webContents
      .executeJavaScript("typeof window.nomadNative", true)
      .then((bridgeType) => {
        writeDevLog("preload-bridge-type", { bridgeType });
        if (bridgeType !== "object") {
          console.error("NomadVNC preload bridge is unavailable", { bridgeType });
          return;
        }

        return window.webContents.executeJavaScript(
          "window.nomadNative.getTailnetState().then((state) => JSON.stringify(state)).catch((error) => `error:${error?.message ?? error}`)",
          true,
        )
          .then((result) => {
            writeDevLog("tailnet-state-probe", { result });
          });
      })
      .catch((error) => {
        console.error("NomadVNC failed to probe preload bridge", error);
        writeDevLog("preload-bridge-probe-error", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
  });

  window.on("maximize", () => broadcastWindowState(window));
  window.on("unmaximize", () => broadcastWindowState(window));
  window.on("enter-full-screen", () => broadcastWindowState(window));
  window.on("leave-full-screen", () => broadcastWindowState(window));
  window.on("restore", () => broadcastWindowState(window));
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
      rendererReady = false;
    }
  });

  return window;
}

function getSecureStorageStatusPayload(): SecureStorageStatus {
  const available = safeStorage.isEncryptionAvailable();
  let backend: string | undefined;
  try {
    const pick = (safeStorage as { getSelectedStorageBackend?: () => string }).getSelectedStorageBackend;
    if (typeof pick === "function") {
      backend = pick.call(safeStorage);
    }
  } catch {
    // ignore
  }

  const hint = !available
    ? process.platform === "linux"
      ? "Use a graphical session with DBus and a Secret Service (GNOME: install gnome-keyring, libsecret; KDE: kwallet). If NomadVNC still cannot use the keyring, set NOMADVNC_PASSWORD_STORE to gnome-libsecret or kwallet5 and restart."
      : "OS secure storage (Keychain on macOS, Credential Manager on Windows) is unavailable. Passwords cannot be saved on this system."
    : undefined;

  return { available, platform: process.platform, backend, hint };
}

interface WindowChromeConfig {
  nativeFrame?: boolean;
}

function readWindowChromeConfig(): WindowChromeConfig {
  try {
    const parsed = JSON.parse(fs.readFileSync(resolveWindowConfigPath(), "utf8")) as WindowChromeConfig;
    return { nativeFrame: parsed.nativeFrame === true };
  } catch {
    return {};
  }
}

/**
 * Effective native-frame flag. `NOMADVNC_NATIVE_FRAME` wins when set (tiling-WM
 * launch scripts); otherwise the renderer's Settings choice from window.json.
 */
function resolveNativeFrame(): { enabled: boolean; managedByEnv: boolean } {
  const env = process.env.NOMADVNC_NATIVE_FRAME?.trim().toLowerCase();
  if (env !== undefined && env !== "") {
    return { enabled: env === "1" || env === "true" || env === "yes", managedByEnv: true };
  }
  return { enabled: readWindowChromeConfig().nativeFrame === true, managedByEnv: false };
}

function writeWindowChromeConfig(config: WindowChromeConfig): void {
  fs.writeFileSync(resolveWindowConfigPath(), JSON.stringify(config));
}

app.whenReady().then(() => {
  if (!isPrimaryInstance) {
    // Another instance owns the lock and already focused itself; this
    // process is quitting, so skip all startup work.
    return;
  }
  const rendererCsp = getRendererCsp(app.isPackaged);
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.resourceType === "mainFrame" || details.resourceType === "subFrame") {
      const responseHeaders = {
        ...details.responseHeaders,
        "Content-Security-Policy": [rendererCsp],
      };
      callback({ responseHeaders });
      return;
    }
    callback({});
  });

  sidecar = new SidecarManager({
    binaryPath: resolveSidecarBinaryPath(),
    stateDir: resolveSidecarStateDir(),
    tailscaleHostname: readTailscaleHostname(),
  });
  credentialStore = new DesktopCredentialStore({
    filePath: resolveCredentialStorePath(),
    secureStorage: safeStorage,
  });

  updateManager = new UpdateManager({
    isPackaged: app.isPackaged,
    userDataDir: app.getPath("userData"),
    currentVersion: app.getVersion(),
    onStatus: (status: UpdateStatus) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("nomadvnc:update-status", status);
      }
    },
    log: (message, detail) => writeDevLog(`updater: ${message}`, detail),
  });
  void updateManager.init().then(() => updateManager.startScheduler());

  const menu = buildApplicationMenuTemplate({
    appName: app.name,
    platform: process.platform,
    isPackaged: app.isPackaged,
    openSettings: requestOpenSettings,
    openHelp: () => openExternalSafely(
      "https://github.com/grpace/NomadVNC/blob/master/docs/guides/using-nomadvnc.md",
    ),
    checkForUpdates: () => {
      void updateManager.checkForUpdates(true);
    },
  }) as MenuItemConstructorOptions[];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu));

  if (!app.isPackaged) {
    const s = getSecureStorageStatusPayload();
    writeDevLog("secure-storage-status", s);
  }

  sidecar.subscribe((payload) => {
    if (payload.type === "authUrl" && payload.authUrl) {
      openExternalSafely(payload.authUrl);
    }
    // Browser handoff complete: the user approved Tailscale out there,
    // so bring the app back to the front for them.
    if (payload.type === "tailnetState" && payload.state?.loggedIn && !tailnetWasLoggedIn) {
      tailnetWasLoggedIn = true;
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) {
          mainWindow.restore();
        }
        mainWindow.focus();
      }
    } else if (payload.type === "tailnetState" && !payload.state?.loggedIn) {
      tailnetWasLoggedIn = false;
    }
  });
  void sidecar.ensureStarted()
    .then(() => writeDevLog("sidecar-started", { stateDir: resolveSidecarStateDir() }))
    .catch((error) => {
      writeDevLog("sidecar-start-failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });

  ipcMain.handle("nomadvnc:ensureTailnetReady", () => sidecar.ensureTailnetReady());
  ipcMain.handle("nomadvnc:getTailnetPeers", () => sidecar.getTailnetPeers());
  ipcMain.handle("nomadvnc:startVncSession", (_, input) => sidecar.startVncSession(input));
  ipcMain.handle("nomadvnc:stopVncSession", (_, sessionId) => sidecar.stopVncSession(sessionId));
  ipcMain.handle("nomadvnc:getTailnetState", () => sidecar.getTailnetState());
  ipcMain.handle("nomadvnc:getSidecarStatus", () => sidecar.getSidecarStatus());
  ipcMain.handle("nomadvnc:logoutTailnet", () => sidecar.logoutTailnet());
  ipcMain.handle("nomadvnc:reauthenticateTailnet", () => sidecar.reauthenticateTailnet());
  ipcMain.handle("nomadvnc:resetTailnetIdentity", () => sidecar.resetTailnetIdentity());
  ipcMain.handle("nomadvnc:setTailscaleHostname", async (_event, hostname: unknown) => {
    const name = typeof hostname === "string" ? hostname : "";
    writeTailscaleHostname(name);
    return sidecar.setTailscaleHostname(name);
  });
  ipcMain.handle("nomadvnc:getNativeFrame", () => resolveNativeFrame());
  ipcMain.handle("nomadvnc:setNativeFrame", (_, enabled: boolean) => {
    writeWindowChromeConfig({ nativeFrame: enabled === true });
    return resolveNativeFrame();
  });
  ipcMain.handle("nomadvnc:relaunchApp", () => {
    app.relaunch();
    app.exit(0);
  });
  ipcMain.handle("nomadvnc:getPeerPath", (_, host: string) => sidecar.getPeerPath(host));
  ipcMain.handle("nomadvnc:getUpdateStatus", () => updateManager.getStatus());
  ipcMain.handle("nomadvnc:getUpdatePrefs", () => updateManager.getPrefs());
  ipcMain.handle("nomadvnc:setUpdatePrefs", (_, prefs: UpdatePrefs) => updateManager.setPrefs(prefs));
  ipcMain.handle("nomadvnc:checkForUpdates", () => updateManager.checkForUpdates(true));
  ipcMain.handle("nomadvnc:installUpdate", () => {
    updateManager.quitAndInstall();
  });
  ipcMain.handle("nomadvnc:getAppVersion", () => updateManager.getCurrentVersion());
  ipcMain.handle("nomadvnc:getWindowsInstall", () => {
    const uninstallerPath = resolveWindowsUninstallerPath({
      platform: process.platform,
      isPackaged: app.isPackaged,
      execPath: process.execPath,
    });
    return uninstallerPath ? { uninstallerPath } : null;
  });
  ipcMain.handle("nomadvnc:uninstallWindowsApp", () => {
    const uninstallerPath = resolveWindowsUninstallerPath({
      platform: process.platform,
      isPackaged: app.isPackaged,
      execPath: process.execPath,
    });
    if (!uninstallerPath) {
      throw new Error("NomadVNC was not installed with the Windows installer.");
    }
    const child = spawn(uninstallerPath, [], { detached: true, stdio: "ignore" });
    child.unref();
    app.quit();
  });
  ipcMain.handle("nomadvnc:canUseSecureStorage", () => credentialStore.canUseSecureStorage());
  ipcMain.handle("nomadvnc:getSecureStorageStatus", () => getSecureStorageStatusPayload());
  ipcMain.handle("nomadvnc:getMachinePassword", (_, machineId: string) => credentialStore.getPassword(machineId));
  ipcMain.handle("nomadvnc:setMachinePassword", (_, input: { machineId: string; password: string }) => credentialStore.setPassword(input.machineId, input.password));
  ipcMain.handle("nomadvnc:deleteMachinePassword", (_, machineId: string) => credentialStore.deletePassword(machineId));
  ipcMain.handle("nomadvnc:getAccountToken", () => credentialStore.getSecret(ACCOUNT_TOKEN_KEY));
  ipcMain.handle("nomadvnc:setAccountToken", (_, token: string) => credentialStore.setSecret(ACCOUNT_TOKEN_KEY, token));
  ipcMain.handle("nomadvnc:deleteAccountToken", () => credentialStore.deleteSecret(ACCOUNT_TOKEN_KEY));
  // One sidecar listener per renderer: a reload (or a second subscribe
  // call) must not stack duplicate listeners that send to a dead page.
  const eventSubscriptions = new Map<number, () => void>();
  ipcMain.handle("nomadvnc:subscribe", (event) => {
    const sender = event.sender;
    if (eventSubscriptions.has(sender.id)) {
      return true;
    }
    const unsubscribe = sidecar.subscribe((payload) => {
      if (!sender.isDestroyed()) {
        sender.send("nomadvnc:event", payload);
      }
    });
    eventSubscriptions.set(sender.id, unsubscribe);
    // A reload keeps the same webContents, so the existing listener simply
    // serves the new page; only a destroyed webContents releases it.
    sender.once("destroyed", () => {
      unsubscribe();
      eventSubscriptions.delete(sender.id);
    });
    return true;
  });
  ipcMain.handle("nomadvnc:readClipboard", () => clipboard.readText());
  ipcMain.handle("nomadvnc:writeClipboard", (_, text: unknown) => {
    if (typeof text === "string") {
      clipboard.writeText(text);
    }
  });
  ipcMain.handle("nomadvnc:accountRequest", (_, request: unknown) =>
    performAccountRequest(request, (url, init) => net.fetch(url, init)),
  );

  mainWindow = createWindow();

  // Cold start via deep link: the URL arrives in this process's argv.
  const coldStartUrl = findAuthCallbackUrl(process.argv.slice(1));
  if (coldStartUrl) {
    const token = extractAuthCallbackToken(coldStartUrl);
    if (token) {
      pendingAuthToken = token;
    }
  }

  ipcMain.handle("nomadvnc:toggleFullscreen", () => {
    if (!mainWindow) {
      return false;
    }

    const isFullScreen = mainWindow.isFullScreen();
    mainWindow.setFullScreen(!isFullScreen);
    const nextState = !isFullScreen;
    broadcastWindowState(mainWindow);
    return nextState;
  });
  ipcMain.handle("nomadvnc:getFullscreen", () => {
    return mainWindow?.isFullScreen() ?? false;
  });
  ipcMain.handle("nomadvnc:getWindowState", () => {
    if (!mainWindow) {
      return { isFullScreen: false, isMaximized: false };
    }

    return getWindowState(mainWindow);
  });
  ipcMain.handle("nomadvnc:minimizeWindow", () => {
    mainWindow?.minimize();
  });
  ipcMain.handle("nomadvnc:toggleMaximizeWindow", () => {
    if (!mainWindow) {
      return false;
    }

    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }

    const nextState = mainWindow.isMaximized();
    broadcastWindowState(mainWindow);
    return nextState;
  });
  ipcMain.handle("nomadvnc:closeWindow", () => {
    mainWindow?.close();
  });
});

app.on("before-quit", () => {
  if (sidecar) {
    void sidecar.dispose();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// macOS keeps the process alive after the last window closes. Clicking the
// Dock icon sends activate, which has to open a window again.
app.on("activate", () => {
  if (!app.isReady()) {
    return;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    focusMainWindow();
    mainWindow.show();
    return;
  }
  mainWindow = createWindow();
});
