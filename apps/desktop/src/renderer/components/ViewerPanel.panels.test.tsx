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

describe("ViewerPanel shortcuts, sticky keys, and layout", () => {
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

  function openShortcutsPanel(): void {
    click(buttonByTitle(container, "Keyboard Shortcuts"));
    expect(container.querySelector(".viewer-dropdown--keys")).not.toBeNull();
  }

  it("opens the shortcuts panel on the universal navigation section", () => {
    renderPanel(baseProps());
    openShortcutsPanel();

    // OS tabs are present with Windows active by default.
    const tabs = Array.from(container.querySelectorAll(".tab-btn"));
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Windows", "macOS", "Linux"]);
    expect(container.querySelector(".tab-btn--active")?.textContent).toBe("Windows");

    // Pager starts at the Navigation section (1 of 5 for Windows).
    expect(container.querySelector(".viewer-shortcut-pager-count")?.textContent).toBe("1 / 5");
    const chips = Array.from(container.querySelectorAll(".viewer-shortcut-chip")).map(
      (chip) => chip.textContent,
    );
    expect(chips).toContain("Up");
    expect(chips).toContain("Esc");
  });

  it("switches OS groups and pages through shortcut sections", () => {
    renderPanel(baseProps());
    openShortcutsPanel();

    click(buttonByText(container, "Linux"));
    expect(container.querySelector(".viewer-shortcut-pager-count")?.textContent).toBe("1 / 5");

    // Page forward to the Linux session section (Navigation → Paging → Function → Linux Session).
    click(buttonByTitle(container, "Next Shortcut Section"));
    click(buttonByTitle(container, "Next Shortcut Section"));
    click(buttonByTitle(container, "Next Shortcut Section"));
    expect(container.querySelector(".viewer-shortcut-pager-count")?.textContent).toBe("4 / 5");
    const chips = Array.from(container.querySelectorAll(".viewer-shortcut-chip")).map(
      (chip) => chip.textContent,
    );
    expect(chips).toContain("Terminal");

    // Two more steps wrap back to Navigation.
    click(buttonByTitle(container, "Next Shortcut Section"));
    click(buttonByTitle(container, "Next Shortcut Section"));
    expect(container.querySelector(".viewer-shortcut-pager-count")?.textContent).toBe("1 / 5");
  });

  it("sends a shortcut and refocuses the viewer", () => {
    const props = baseProps();
    renderPanel(props);
    openShortcutsPanel();

    click(buttonByText(container, "Up"));
    expect(props.onRefocusViewer).toHaveBeenCalled();
  });

  it("latches sticky modifiers and clears them on demand", () => {
    const props = baseProps();
    renderPanel(props);
    openShortcutsPanel();

    const summary = () => container.querySelector(".viewer-dropdown-sticky-summary")?.textContent;
    const clearButton = () => buttonByText(container, "Clear");

    expect(summary()).toBe("No modifiers latched");
    expect(clearButton().disabled).toBe(true);

    click(buttonByText(container, "Ctrl"));
    const ctrlButton = buttonByText(container, "Ctrl");
    expect(ctrlButton.className).toContain("sticky-btn--active");
    expect(summary()).toBe("1 modifier latched");
    expect(clearButton().disabled).toBe(false);

    click(buttonByText(container, "Alt"));
    expect(summary()).toBe("2 modifiers latched");

    click(clearButton());
    expect(summary()).toBe("No modifiers latched");
    expect(buttonByText(container, "Ctrl").className).not.toContain("sticky-btn--active");
    // Toggle Ctrl, toggle Alt, clear — each refocuses the viewer canvas.
    expect(props.onRefocusViewer).toHaveBeenCalledTimes(3);
  });

  it("toggles scale modes and refocuses the viewer", () => {    const props = baseProps();
    renderPanel(props);

    const fitButton = buttonByTitle(container, "Fit to Window");
    const actualButton = buttonByTitle(container, "Actual Size (1:1)");
    expect(fitButton.className).toContain("btn--toolbar-active");

    click(actualButton);
    expect(buttonByTitle(container, "Actual Size (1:1)").className).toContain("btn--toolbar-active");
    expect(fitButton.className).not.toContain("btn--toolbar-active");
    expect(container.querySelector(".viewer-surface--actual")).not.toBeNull();
    expect(props.onRefocusViewer).toHaveBeenCalledTimes(1);
  });

  it("selects zoom presets and shows the active level", () => {
    const props = baseProps();
    renderPanel(props);

    const zoomButton = buttonByTitle(container, "Zoom Level");
    expect(zoomButton.textContent).toBe("Zoom");
    click(zoomButton);
    expect(container.querySelector(".viewer-dropdown--zoom")).not.toBeNull();

    click(buttonByText(container, "150%"));
    expect(buttonByTitle(container, "Zoom Level").textContent).toBe("150%");
    expect(container.querySelector(".viewer-surface--zoom")).not.toBeNull();
    expect(container.querySelector(".viewer-surface--actual")).toBeNull();
    expect(props.onRefocusViewer).toHaveBeenCalledTimes(1);

    // The dropdown stays open for quick comparisons.
    expect(container.querySelector(".viewer-dropdown--zoom")).not.toBeNull();
  });

  it("returns to fit mode from zoom", () => {
    const props = baseProps();
    renderPanel(props);

    click(buttonByTitle(container, "Zoom Level"));
    click(buttonByText(container, "200%"));
    expect(buttonByTitle(container, "Zoom Level").textContent).toBe("200%");

    click(buttonByTitle(container, "Fit to Window"));
    expect(buttonByTitle(container, "Zoom Level").textContent).toBe("Zoom");
    expect(container.querySelector(".viewer-surface--zoom")).toBeNull();
    expect(container.querySelector(".viewer-dropdown--zoom")).toBeNull();
    expect(props.onRefocusViewer).toHaveBeenCalledTimes(2);
  });

  it("transitions between normal and fullscreen chrome", () => {
    const props = baseProps();
    renderPanel(props);

    expect(container.querySelector(".viewer-frame--fullscreen")).toBeNull();
    expect(buttonByTitle(container, "Fullscreen").textContent).toContain("Fullscreen");

    renderPanel({ ...props, isFullscreen: true });
    expect(container.querySelector(".viewer-frame--fullscreen")).not.toBeNull();
    expect(buttonByTitle(container, "Exit Fullscreen").textContent).toContain("Exit Fullscreen");

    renderPanel({ ...props, isFullscreen: false });
    expect(container.querySelector(".viewer-frame--fullscreen")).toBeNull();
  });
});
