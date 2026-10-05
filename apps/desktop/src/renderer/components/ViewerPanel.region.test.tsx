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

async function dispatchViewerResize(width: number, height: number): Promise<void> {
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "viewerResize", width, height } }),
    );
  });
}

const PREFS = {
  scaleMode: "fit",
  zoomLevel: 1,
  quality: 6,
  osTab: "Windows",
  captureKeys: false,
  autoQuality: false,
  displayRegion: "full",
};

describe("ViewerPanel monitor areas", () => {
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

  function openZoom(): void {
    click(buttonByTitle(container, "Zoom Level"));
  }

  it("disables halves until the framebuffer size is known", () => {
    renderPanel(baseProps({ viewPrefsKey: "machine-1", initialViewPrefs: PREFS }));
    openZoom();

    expect(buttonByText(container, "Left Half").disabled).toBe(true);
    expect(buttonByText(container, "Full Display").disabled).toBe(false);
  });

  it("zooms a half to fit and reports the region pref", async () => {
    const onViewPrefsChange = vi.fn();
    renderPanel(
      baseProps({ viewPrefsKey: "machine-1", initialViewPrefs: PREFS, onViewPrefsChange }),
    );
    const postMessage = mockIframePost();
    await dispatchViewerResize(3840, 1080);

    openZoom();
    expect(buttonByText(container, "Left Half").disabled).toBe(false);
    postMessage.mockClear();
    click(buttonByText(container, "Left Half"));

    // The viewer fits and pans to the half itself; the toolbar names it.
    expect(postMessage).toHaveBeenCalledWith({ type: "setDisplayRegion", region: "left" }, "*");
    expect(onViewPrefsChange).toHaveBeenCalledWith(
      expect.objectContaining({ displayRegion: "left", scaleMode: "zoom" }),
    );
    expect(buttonByTitle(container, "Zoom Level").textContent).toBe("Left Half");
  });

  it("returns to fit through the full-display region", async () => {
    renderPanel(baseProps({ viewPrefsKey: "machine-1", initialViewPrefs: PREFS }));
    const postMessage = mockIframePost();
    await dispatchViewerResize(3840, 1080);

    openZoom();
    click(buttonByText(container, "Right Half"));
    postMessage.mockClear();
    click(buttonByText(container, "Full Display"));

    expect(postMessage).toHaveBeenCalledWith({ type: "setScaleMode", mode: "fit" }, "*");
    expect(buttonByTitle(container, "Zoom Level").textContent).toBe("Zoom");
  });

  it("auto-applies a remembered region once the display size arrives", async () => {
    const onViewPrefsChange = vi.fn();
    renderPanel(
      baseProps({
        viewPrefsKey: "machine-1",
        initialViewPrefs: { ...PREFS, displayRegion: "right" },
        onViewPrefsChange,
      }),
    );
    const postMessage = mockIframePost();
    postMessage.mockClear();

    await dispatchViewerResize(3840, 1080);

    expect(postMessage).toHaveBeenCalledWith({ type: "setDisplayRegion", region: "right" }, "*");
    expect(onViewPrefsChange).toHaveBeenCalledWith(
      expect.objectContaining({ displayRegion: "right" }),
    );
  });
});
