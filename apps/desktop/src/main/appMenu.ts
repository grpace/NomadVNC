/**
 * The macOS menu bar (and the hidden Windows/Linux application menu).
 * Setting the menu to null leaves macOS with a single Quit item and
 * disables the Edit shortcuts text fields rely on.
 */

export interface ApplicationMenuActions {
  appName: string;
  platform: NodeJS.Platform;
  /** Unpackaged builds add reload and developer tools. */
  isPackaged: boolean;
  openSettings: () => void;
  openHelp: () => void;
  checkForUpdates: () => void;
}

export interface ApplicationMenuItem {
  label?: string;
  role?: string;
  type?: "separator";
  accelerator?: string;
  submenu?: ApplicationMenuItem[];
  click?: () => void;
}

export function buildApplicationMenuTemplate(
  actions: ApplicationMenuActions,
): ApplicationMenuItem[] {
  const isMac = actions.platform === "darwin";
  const settingsItem: ApplicationMenuItem = {
    label: "Settings…",
    accelerator: "CmdOrCtrl+,",
    click: actions.openSettings,
  };
  const updatesItem: ApplicationMenuItem = {
    label: "Check for Updates…",
    click: actions.checkForUpdates,
  };
  const helpItem: ApplicationMenuItem = {
    label: "NomadVNC Guide",
    click: actions.openHelp,
  };

  const viewSubmenu: ApplicationMenuItem[] = [];
  if (!actions.isPackaged) {
    viewSubmenu.push(
      { role: "reload" },
      { role: "toggleDevTools" },
      { type: "separator" },
    );
  }
  viewSubmenu.push({ role: "togglefullscreen" });

  const template: ApplicationMenuItem[] = [];

  if (isMac) {
    template.push({
      label: actions.appName,
      submenu: [
        { role: "about" },
        { type: "separator" },
        settingsItem,
        updatesItem,
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    });
  }

  template.push(
    {
      label: "File",
      submenu: isMac
        ? [{ role: "close" }]
        : [settingsItem, { type: "separator" }, { role: "quit" }],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "delete" },
        { type: "separator" },
        { role: "selectAll" },
      ],
    },
    { label: "View", submenu: viewSubmenu },
    {
      label: "Window",
      submenu: isMac
        ? [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }]
        : [{ role: "minimize" }, { role: "zoom" }, { role: "close" }],
    },
    {
      label: "Help",
      submenu: isMac ? [helpItem] : [updatesItem, helpItem],
    },
  );

  return template;
}
