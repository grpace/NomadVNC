// Runs sandboxed: only contextBridge + ipcRenderer are available here, so
// every privileged operation (clipboard included) is a main-process IPC.
import { contextBridge, ipcRenderer } from "electron";
import { cleanIpcErrorMessage } from "./ipcErrors";
import type { NomadNativePlatform, StartVncSessionInput } from "@nomadvnc/platform-contracts";

/** `ipcRenderer.invoke` with errors cleaned up for display (see ipcErrors). */
function invoke<T = unknown>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcRenderer.invoke(channel, ...args).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(cleanIpcErrorMessage(message));
  });
}

const api: NomadNativePlatform = {
  ensureTailnetReady: () => invoke("nomadvnc:ensureTailnetReady"),
  getTailnetPeers: () => invoke("nomadvnc:getTailnetPeers"),
  startVncSession: (input: StartVncSessionInput) => invoke("nomadvnc:startVncSession", input),
  stopVncSession: (sessionId: string) => invoke("nomadvnc:stopVncSession", sessionId),
  getTailnetState: () => invoke("nomadvnc:getTailnetState"),
  getSidecarStatus: () => invoke("nomadvnc:getSidecarStatus"),
  getUpdateStatus: () => invoke("nomadvnc:getUpdateStatus"),
  getUpdatePrefs: () => invoke("nomadvnc:getUpdatePrefs"),
  setUpdatePrefs: (prefs) => invoke("nomadvnc:setUpdatePrefs", prefs),
  checkForUpdates: () => invoke("nomadvnc:checkForUpdates"),
  installUpdate: () => invoke("nomadvnc:installUpdate"),
  getAppVersion: () => invoke("nomadvnc:getAppVersion"),
  getWindowsInstall: () => invoke("nomadvnc:getWindowsInstall"),
  uninstallWindowsApp: () => invoke("nomadvnc:uninstallWindowsApp"),
  onUpdateStatus: (listener) => {
    const handler = (_event: unknown, status: Parameters<typeof listener>[0]) => listener(status);
    ipcRenderer.on("nomadvnc:update-status", handler);
    return () => ipcRenderer.off("nomadvnc:update-status", handler);
  },
  logoutTailnet: () => invoke("nomadvnc:logoutTailnet"),
  resetTailnetIdentity: () => invoke("nomadvnc:resetTailnetIdentity"),
  setTailscaleHostname: (hostname: string) => invoke("nomadvnc:setTailscaleHostname", hostname),
  reauthenticateTailnet: () => invoke("nomadvnc:reauthenticateTailnet"),
  getPeerPath: (host: string) => invoke("nomadvnc:getPeerPath", host),
  canUseSecureStorage: () => invoke("nomadvnc:canUseSecureStorage"),
  getSecureStorageStatus: () => invoke("nomadvnc:getSecureStorageStatus"),
  getMachinePassword: (machineId: string) => invoke("nomadvnc:getMachinePassword", machineId),
  setMachinePassword: (machineId: string, password: string) => invoke("nomadvnc:setMachinePassword", { machineId, password }),
  deleteMachinePassword: (machineId: string) => invoke("nomadvnc:deleteMachinePassword", machineId),
  getAccountToken: () => invoke("nomadvnc:getAccountToken"),
  setAccountToken: (token: string) => invoke("nomadvnc:setAccountToken", token),
  deleteAccountToken: () => invoke("nomadvnc:deleteAccountToken"),
  toggleFullscreen: () => invoke("nomadvnc:toggleFullscreen"),
  getFullscreen: () => invoke("nomadvnc:getFullscreen"),
  getWindowState: () => invoke("nomadvnc:getWindowState"),
  minimizeWindow: () => invoke("nomadvnc:minimizeWindow"),
  toggleMaximizeWindow: () => invoke("nomadvnc:toggleMaximizeWindow"),
  closeWindow: () => invoke("nomadvnc:closeWindow"),
  getNativeFrame: () => invoke("nomadvnc:getNativeFrame"),
  setNativeFrame: (enabled: boolean) => invoke("nomadvnc:setNativeFrame", enabled),
  relaunchApp: () => invoke("nomadvnc:relaunchApp"),
  readClipboard: () => invoke("nomadvnc:readClipboard"),
  writeClipboard: (text: string) => invoke("nomadvnc:writeClipboard", text),
  accountRequest: (request) => invoke("nomadvnc:accountRequest", request),
  subscribe: (listener) => {
    const handler = (_event: unknown, payload: Parameters<typeof listener>[0]) => listener(payload);
    ipcRenderer.on("nomadvnc:event", handler);
    void invoke("nomadvnc:subscribe").catch(() => {});
    return () => ipcRenderer.off("nomadvnc:event", handler);
  },
  subscribeWindowState: (listener) => {
    const handler = (_event: unknown, payload: Parameters<typeof listener>[0]) => listener(payload);
    ipcRenderer.on("nomadvnc:windowState", handler);
    return () => ipcRenderer.off("nomadvnc:windowState", handler);
  },
  onAuthCallback: (listener) => {
    const handler = (_event: unknown, payload: { token?: unknown }) => {
      if (payload && typeof payload.token === "string" && payload.token !== "") {
        listener(payload.token);
      }
    };
    ipcRenderer.on("nomadvnc:auth-callback", handler);
    return () => ipcRenderer.off("nomadvnc:auth-callback", handler);
  },
  onOpenSettings: (listener) => {
    const handler = () => listener();
    ipcRenderer.on("nomadvnc:open-settings", handler);
    return () => ipcRenderer.off("nomadvnc:open-settings", handler);
  },
};

contextBridge.exposeInMainWorld("nomadNative", api);
