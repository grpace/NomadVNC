import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ViewerPanel } from "./ViewerPanel";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function baseProps(overrides: Record<string, unknown> = {}) {
  return {
    session: {
      sessionId: "session-1",
      wsUrl: "ws://127.0.0.1:49001",
      label: "Lab Desktop",
      host: "lab.tail.ts.net",
      port: 5900,
    },
    viewerHtml: "<!doctype html><html><body>viewer</body></html>",
    isFullscreen: false,
    sessionKey: 0,
    onDisconnect: vi.fn(),
    onToggleFullscreen: vi.fn(),
    onRefocusViewer: vi.fn(),
    ...overrides,
  };
}

function buttonByTitle(container: ParentNode, title: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.getAttribute("title") === title,
  );
  if (!button) {
    throw new Error(`No button with title "${title}"`);
  }
  return button as HTMLButtonElement;
}

function buttonByText(container: ParentNode, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!button) {
    throw new Error(`No button with text "${text}"`);
  }
  return button as HTMLButtonElement;
}

function click(button: HTMLButtonElement): void {
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function qualityOption(container: ParentNode, label: string): HTMLButtonElement {
  const option = Array.from(container.querySelectorAll(".quality-option")).find(
    (candidate) => candidate.querySelector(".quality-option-label")?.textContent === label,
  );
  if (!option) {
    throw new Error(`No quality option "${label}"`);
  }
  return option as HTMLButtonElement;
}

function mockKeyboardLock() {
  const lock = vi.fn(async () => {});
  const unlock = vi.fn(() => {});
  Object.defineProperty(window.navigator, "keyboard", {
    value: { lock, unlock },
    configurable: true,
  });
  return { lock, unlock };
}

function unmockKeyboardLock() {
  const nav = window.navigator as Navigator & { keyboard?: unknown };
  if ("keyboard" in nav) {
    delete nav.keyboard;
  }
}

async function flushPromises(): Promise<void> {
  await act(async () => {});
}

describe("ViewerPanel per-machine view prefs", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    (window as unknown as Record<string, unknown>).nomadNative = {
      readClipboard: async () => "",
      writeClipboard: async () => {},
    };
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    container.remove();
    delete (window as unknown as Record<string, unknown>).nomadNative;
  });

  function renderPanel(props: ReturnType<typeof baseProps>): void {
    act(() => {
      if (!root) {
        root = createRoot(container);
      }
      root.render(<ViewerPanel {...props} />);
    });
  }

  it("applies stored prefs to the zoom button, quality, and OS tab", () => {
    renderPanel(
      baseProps({
        viewPrefsKey: "machine-1",
        initialViewPrefs: { scaleMode: "zoom", zoomLevel: 1.5, quality: 8, osTab: "Linux" },
      }),
    );

    expect(buttonByTitle(container, "Zoom Level").textContent).toBe("150%");

    click(buttonByTitle(container, "Session Settings"));
    expect(qualityOption(container, "High").className).toContain("quality-option--active");

    click(buttonByTitle(container, "Keyboard Shortcuts"));
    expect(container.querySelector(".tab-btn--active")?.textContent).toBe("Linux");
  });

  it("reports quality and OS-tab changes through onViewPrefsChange", () => {
    const onViewPrefsChange = vi.fn();
    renderPanel(baseProps({ viewPrefsKey: "machine-1", onViewPrefsChange }));

    click(buttonByTitle(container, "Session Settings"));
    click(qualityOption(container, "Low"));
    expect(onViewPrefsChange).toHaveBeenCalledWith(
      expect.objectContaining({ quality: 2 }),
    );

    click(buttonByTitle(container, "Keyboard Shortcuts"));
    click(buttonByText(container, "Linux"));
    expect(onViewPrefsChange).toHaveBeenCalledWith(
      expect.objectContaining({ osTab: "Linux" }),
    );
  });

  it("re-asserts a remembered capture-keys pref by grabbing keyboard lock", async () => {
    const { lock } = mockKeyboardLock();
    try {
      renderPanel(
        baseProps({
          viewPrefsKey: "machine-1",
          initialViewPrefs: { scaleMode: "fit", zoomLevel: 1, quality: 6, osTab: "Windows", captureKeys: true },
        }),
      );
      await flushPromises();

      expect(lock).toHaveBeenCalledTimes(1);
      expect(buttonByText(container, "Capture").className).toContain("btn--toolbar-active");
    } finally {
      unmockKeyboardLock();
    }
  });

  it("toggles capture off and reports the pref change", async () => {
    const { unlock } = mockKeyboardLock();
    const onViewPrefsChange = vi.fn();
    try {
      renderPanel(
        baseProps({
          viewPrefsKey: "machine-1",
          initialViewPrefs: { scaleMode: "fit", zoomLevel: 1, quality: 6, osTab: "Windows", captureKeys: true },
          onViewPrefsChange,
        }),
      );
      await flushPromises();

      click(buttonByText(container, "Capture"));
      await flushPromises();

      expect(unlock).toHaveBeenCalledTimes(1);
      expect(onViewPrefsChange).toHaveBeenCalledWith(
        expect.objectContaining({ captureKeys: false }),
      );
      expect(buttonByText(container, "Capture").className).not.toContain("btn--toolbar-active");
    } finally {
      unmockKeyboardLock();
    }
  });

  it("disables the capture toggle when keyboard lock is unavailable", () => {
    unmockKeyboardLock();
    renderPanel(baseProps({ viewPrefsKey: "machine-1" }));

    const capture = buttonByText(container, "Capture");
    expect(capture.disabled).toBe(true);
    expect(capture.title).toContain("not supported");
  });
});
