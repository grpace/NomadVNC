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

function click(button: HTMLButtonElement): void {
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function dispatchViewerEvent(type: string): Promise<void> {
  await act(async () => {
    window.dispatchEvent(new MessageEvent("message", { data: { type } }));
  });
}

const PREFS = {
  scaleMode: "fit",
  zoomLevel: 1,
  quality: 8,
  osTab: "Windows",
  captureKeys: false,
  autoQuality: true,
};

const RELAY_PATH = {
  host: "lab.tail.ts.net",
  found: true,
  path: "relay",
  latencyMs: 300,
  relayRegion: "sea",
};

describe("ViewerPanel auto quality", () => {
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

  function mockIframePost(): ReturnType<typeof vi.fn> {
    const postMessage = vi.fn();
    const iframe = container.querySelector("iframe");
    if (!iframe) {
      throw new Error("No viewer iframe");
    }
    Object.defineProperty(iframe, "contentWindow", {
      value: { postMessage },
      configurable: true,
    });
    return postMessage;
  }

  it("shows the auto-degraded effective quality while keeping the manual ceiling", () => {
    renderPanel(
      baseProps({ viewPrefsKey: "machine-1", initialViewPrefs: PREFS, connectionPath: RELAY_PATH }),
    );

    click(buttonByTitle(container, "Session Settings"));
    expect(container.textContent).toContain("Auto: Low");
    // The manual ceiling (High) stays selected; auto only degrades below it.
    const active = container.querySelector(".quality-option--active .quality-option-label");
    expect(active?.textContent).toBe("High");
  });

  it("toggles auto quality off and reports the pref change", () => {
    const onViewPrefsChange = vi.fn();
    renderPanel(
      baseProps({
        viewPrefsKey: "machine-1",
        initialViewPrefs: PREFS,
        connectionPath: RELAY_PATH,
        onViewPrefsChange,
      }),
    );

    click(buttonByTitle(container, "Session Settings"));
    const toggle = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Auto Quality: ON",
    ) as HTMLButtonElement;
    click(toggle);

    expect(onViewPrefsChange).toHaveBeenCalledWith(
      expect.objectContaining({ autoQuality: false }),
    );
    expect(container.textContent).not.toContain("Auto: Low");
  });

  it("sharpens to lossless on idle and restores on activity", async () => {
    renderPanel(
      baseProps({ viewPrefsKey: "machine-1", initialViewPrefs: PREFS, connectionPath: RELAY_PATH }),
    );
    const postMessage = mockIframePost();
    postMessage.mockClear();

    await dispatchViewerEvent("viewerIdle");
    expect(postMessage).toHaveBeenCalledWith({ type: "setQuality", quality: 9 }, "*");

    await dispatchViewerEvent("viewerActive");
    expect(postMessage).toHaveBeenCalledWith({ type: "setQuality", quality: 2 }, "*");
  });

  it("leaves fast direct paths at the manual quality", () => {
    renderPanel(
      baseProps({
        viewPrefsKey: "machine-1",
        initialViewPrefs: PREFS,
        connectionPath: { host: "lab.tail.ts.net", found: true, path: "direct", latencyMs: 32 },
      }),
    );

    click(buttonByTitle(container, "Session Settings"));
    expect(container.textContent).not.toContain("Auto: Low");
  });
});
