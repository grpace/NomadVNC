import { describe, expect, it, vi } from "vitest";
import { buildApplicationMenuTemplate, type ApplicationMenuItem } from "./appMenu";

function itemNames(items: ApplicationMenuItem[], prefix = ""): string[] {
  const names: string[] = [];
  for (const item of items) {
    const name = item.label ?? item.role ?? item.type ?? "?";
    if (item.submenu) {
      names.push(...itemNames(item.submenu, name));
    } else if (item.type !== "separator") {
      names.push(prefix ? `${prefix} / ${name}` : name);
    }
  }
  return names;
}

function actions(platform: NodeJS.Platform, isPackaged = true) {
  return {
    appName: "NomadVNC",
    platform,
    isPackaged,
    openSettings: vi.fn(),
    openHelp: vi.fn(),
    checkForUpdates: vi.fn(),
  };
}

describe("buildApplicationMenuTemplate", () => {
  it("gives macOS the standard menus, not a Quit-only bar", () => {
    const names = itemNames(buildApplicationMenuTemplate(actions("darwin")));
    expect(names).toEqual([
      "NomadVNC / about",
      "NomadVNC / Settings…",
      "NomadVNC / Check for Updates…",
      "NomadVNC / services",
      "NomadVNC / hide",
      "NomadVNC / hideOthers",
      "NomadVNC / unhide",
      "NomadVNC / quit",
      "File / close",
      "Edit / undo",
      "Edit / redo",
      "Edit / cut",
      "Edit / copy",
      "Edit / paste",
      "Edit / pasteAndMatchStyle",
      "Edit / delete",
      "Edit / selectAll",
      "View / togglefullscreen",
      "Window / minimize",
      "Window / zoom",
      "Window / front",
      "Help / NomadVNC Guide",
    ]);
  });

  it("puts Settings and Quit in the File menu on Windows and Linux", () => {
    const names = itemNames(buildApplicationMenuTemplate(actions("linux")));
    expect(names).toContain("File / Settings…");
    expect(names).toContain("File / quit");
    expect(names).toContain("Help / Check for Updates…");
    expect(names).not.toContain("NomadVNC / quit");
  });

  it("adds developer items only to unpackaged builds", () => {
    const packaged = itemNames(buildApplicationMenuTemplate(actions("darwin", true)));
    const dev = itemNames(buildApplicationMenuTemplate(actions("darwin", false)));
    expect(packaged).not.toContain("View / toggleDevTools");
    expect(dev).toContain("View / reload");
    expect(dev).toContain("View / toggleDevTools");
  });

  it("runs the Settings, updates, and help actions", () => {
    const menu = actions("darwin");
    const template = buildApplicationMenuTemplate(menu);
    const appMenu = template[0]?.submenu ?? [];
    appMenu.find((item) => item.label === "Settings…")?.click?.();
    appMenu.find((item) => item.label === "Check for Updates…")?.click?.();
    const help = template.find((item) => item.label === "Help")?.submenu ?? [];
    help.find((item) => item.label === "NomadVNC Guide")?.click?.();
    expect(menu.openSettings).toHaveBeenCalledOnce();
    expect(menu.checkForUpdates).toHaveBeenCalledOnce();
    expect(menu.openHelp).toHaveBeenCalledOnce();
  });
});
