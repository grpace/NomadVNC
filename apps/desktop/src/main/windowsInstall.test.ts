import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWindowsUninstallerPath, WINDOWS_UNINSTALLER_NAME } from "./windowsInstall";

describe("resolveWindowsUninstallerPath", () => {
  const execPath = path.join("/Program Files/NomadVNC", "NomadVNC.exe");
  const uninstaller = path.join("/Program Files/NomadVNC", WINDOWS_UNINSTALLER_NAME);

  it("returns the uninstaller beside a packaged Windows executable", () => {
    expect(
      resolveWindowsUninstallerPath({
        platform: "win32",
        isPackaged: true,
        execPath,
        exists: (filePath) => filePath === uninstaller,
      }),
    ).toBe(uninstaller);
  });

  it("returns null when the uninstaller is missing", () => {
    expect(
      resolveWindowsUninstallerPath({
        platform: "win32",
        isPackaged: true,
        execPath,
        exists: () => false,
      }),
    ).toBeNull();
  });

  it("returns null for unpackaged and non-Windows runs", () => {
    expect(
      resolveWindowsUninstallerPath({
        platform: "win32",
        isPackaged: false,
        execPath,
        exists: () => true,
      }),
    ).toBeNull();
    expect(
      resolveWindowsUninstallerPath({
        platform: "linux",
        isPackaged: true,
        execPath,
        exists: () => true,
      }),
    ).toBeNull();
  });
});
