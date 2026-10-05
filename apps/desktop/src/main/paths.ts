import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));

function desktopRoot(): string {
  return path.resolve(currentDir, "../..");
}

function workspaceRoot(): string {
  return path.resolve(currentDir, "../../../..");
}

function sidecarBinaryName(): string {
  return process.platform === "win32" ? "nomadvnc-sidecar.exe" : "nomadvnc-sidecar";
}

export function resolvePreloadPath(): string {
  return path.resolve(desktopRoot(), "dist-electron/preload/preload.cjs");
}

export function resolveRendererEntryUrl(): string {
  // Dev-server override only: a packaged app must never load a page from
  // an env var into the window that holds the privileged bridge.
  if (!app.isPackaged && process.env.NOMADVNC_DESKTOP_URL) {
    return process.env.NOMADVNC_DESKTOP_URL;
  }

  const indexPath = path.resolve(desktopRoot(), "dist-electron/renderer/index.html");
  return pathToFileURL(indexPath).toString();
}

export function resolveSidecarBinaryPath(): string {
  if (process.env.NOMADVNC_SIDECAR_PATH) {
    return process.env.NOMADVNC_SIDECAR_PATH;
  }

  if (app.isPackaged) {
    return path.join(process.resourcesPath, "sidecar", sidecarBinaryName());
  }

  return path.resolve(workspaceRoot(), "go-core/bin", sidecarBinaryName());
}

export function resolveSidecarStateDir(): string {
  return path.join(app.getPath("userData"), "sidecar-state");
}

/** Renderer-editable window chrome config (native-frame fallback). */
export function resolveWindowConfigPath(): string {
  return path.join(app.getPath("userData"), "window.json");
}

export function resolveCredentialStorePath(): string {
  return path.join(app.getPath("userData"), "credential-store.json");
}

export function resolveWindowIconPath(): string | undefined {
  if (app.isPackaged) {
    return undefined;
  }

  const iconPath = path.resolve(desktopRoot(), "build/icon.png");
  return fs.existsSync(iconPath) ? iconPath : undefined;
}
