import fs from "node:fs";
import path from "node:path";

/** Must match `build.appId` so taskbar shortcuts and the installer agree. */
export const WINDOWS_APP_USER_MODEL_ID = "com.nomadvnc.desktop";

/** Filename electron-builder writes next to the installed executable. */
export const WINDOWS_UNINSTALLER_NAME = "Uninstall NomadVNC.exe";

/**
 * Path to the NSIS uninstaller for a packaged Windows build.
 * Dev runs and other platforms have no installer entry, so this is null.
 */
export function resolveWindowsUninstallerPath(input: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  execPath: string;
  exists?: (filePath: string) => boolean;
}): string | null {
  if (input.platform !== "win32" || !input.isPackaged) {
    return null;
  }
  const candidate = path.join(path.dirname(input.execPath), WINDOWS_UNINSTALLER_NAME);
  const exists = input.exists ?? fs.existsSync;
  return exists(candidate) ? candidate : null;
}
