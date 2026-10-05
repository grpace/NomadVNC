import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "@nomadvnc/platform-contracts";
import { UpdatesSection } from "./UpdatesSection";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type StatusListener = (status: UpdateStatus) => void;

function installNativeMock(overrides?: Partial<Record<string, unknown>>) {
  let statusListener: StatusListener | null = null;
  const mock = {
    getAppVersion: vi.fn(async () => "0.1.0"),
    getUpdatePrefs: vi.fn(async () => ({ enabled: true, autoCheck: true })),
    setUpdatePrefs: vi.fn(async (prefs: unknown) => prefs),
    getUpdateStatus: vi.fn(async (): Promise<UpdateStatus> => ({ state: "idle" })),
    checkForUpdates: vi.fn(async (): Promise<UpdateStatus> => ({ state: "checking" })),
    installUpdate: vi.fn(async () => {}),
    onUpdateStatus: vi.fn((listener: StatusListener) => {
      statusListener = listener;
      return () => {
        statusListener = null;
      };
    }),
    ...overrides,
  };
  (window as unknown as Record<string, unknown>).nomadNative = mock;
  return {
    mock,
    emit: (status: UpdateStatus) => {
      act(() => {
        statusListener?.(status);
      });
    },
  };
}

function mountSection(container: HTMLDivElement): Root {
  const root = createRoot(container);
  act(() => {
    root.render(<UpdatesSection />);
  });
  return root;
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("UpdatesSection", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    delete (window as unknown as Record<string, unknown>).nomadNative;
  });

  afterEach(() => {
    container.remove();
    delete (window as unknown as Record<string, unknown>).nomadNative;
  });

  it("renders nothing when the updates API is absent", () => {
    const root = mountSection(container);
    try {
      expect(container.innerHTML).toBe("");
    } finally {
      act(() => root.unmount());
    }
  });

  it("shows the version, toggle, and check button once loaded", async () => {
    const { mock } = installNativeMock();
    const root = mountSection(container);
    try {
      await flushPromises();
      expect(container.textContent).toContain("NomadVNC");
      expect(container.textContent).toContain("0.1.0");
      expect(container.textContent).toContain("Automatically Check for Updates");
      expect(container.textContent).toContain("Check for Updates");
      expect(mock.getAppVersion).toHaveBeenCalled();
      expect(mock.getUpdatePrefs).toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });

  it("runs a manual check from the button", async () => {
    const { mock } = installNativeMock();
    const root = mountSection(container);
    try {
      await flushPromises();
      const button = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Check for Updates"),
      );
      expect(button).toBeTruthy();
      await act(async () => {
        button!.click();
      });
      expect(mock.checkForUpdates).toHaveBeenCalledTimes(1);
      expect(container.textContent).toContain("Checking");
    } finally {
      act(() => root.unmount());
    }
  });

  it("shows restart-to-install when an update is ready", async () => {
    const { mock, emit } = installNativeMock();
    const root = mountSection(container);
    try {
      await flushPromises();
      emit({ state: "ready", version: "0.2.0" });
      expect(container.textContent).toContain("Restart and Install");
      expect(container.textContent).toContain("0.2.0");
      const install = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Restart and Install"),
      );
      await act(async () => {
        install!.click();
      });
      expect(mock.installUpdate).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
    }
  });

  it("shows download progress while downloading", async () => {
    const { emit } = installNativeMock();
    const root = mountSection(container);
    try {
      await flushPromises();
      emit({ state: "downloading", version: "0.2.0", percent: 42 });
      expect(container.textContent).toContain("42%");
      const fill = container.querySelector<HTMLDivElement>(".update-progress-fill");
      expect(fill?.style.width).toBe("42%");
    } finally {
      act(() => root.unmount());
    }
  });

  it("offers uninstall only for a packaged Windows install", async () => {
    const uninstallWindowsApp = vi.fn(async () => {});
    installNativeMock({
      getWindowsInstall: vi.fn(async () => ({ uninstallerPath: "C:\\Program Files\\NomadVNC\\Uninstall NomadVNC.exe" })),
      uninstallWindowsApp,
    });
    const root = mountSection(container);
    try {
      await flushPromises();
      const start = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Uninstall");
      expect(start).toBeTruthy();
      await act(async () => {
        start!.click();
      });
      expect(container.textContent).toContain("opens the Windows uninstaller");
      const confirm = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent === "Uninstall NomadVNC",
      );
      await act(async () => {
        confirm!.click();
      });
      expect(uninstallWindowsApp).toHaveBeenCalledTimes(1);
    } finally {
      act(() => root.unmount());
    }
  });

  it("persists the auto-check toggle through setUpdatePrefs", async () => {
    const { mock } = installNativeMock();
    const root = mountSection(container);
    try {
      await flushPromises();
      const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
      expect(checkbox?.checked).toBe(true);
      await act(async () => {
        checkbox!.click();
      });
      expect(mock.setUpdatePrefs).toHaveBeenCalledWith({ enabled: true, autoCheck: false });
    } finally {
      act(() => root.unmount());
    }
  });
});
