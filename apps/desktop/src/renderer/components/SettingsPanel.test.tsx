import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_APP_SETTINGS, type AppSettings } from "../appSettings";
import { SettingsPanel } from "./SettingsPanel";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function mountPanel(
  container: HTMLDivElement,
  props: Partial<{
    settings: AppSettings;
    secureStorage: { available: boolean; platform: string; backend?: string; hint?: string } | null;
    nativeFrame: { enabled: boolean; managedByEnv: boolean } | null;
    nativeFrameNeedsRestart: boolean;
  }>,
): { root: Root; onChange: ReturnType<typeof vi.fn>; onNativeFrameChange: ReturnType<typeof vi.fn>; onRelaunch: ReturnType<typeof vi.fn> } {
  const onChange = vi.fn();
  const onNativeFrameChange = vi.fn();
  const onRelaunch = vi.fn();
  const root = createRoot(container);
  act(() => {
    root.render(
      <SettingsPanel
        settings={props.settings ?? DEFAULT_APP_SETTINGS}
        secureStorage={props.secureStorage === undefined ? { available: true, platform: "linux", backend: "gnome-libsecret" } : props.secureStorage}
        onChange={onChange}
        nativeFrame={props.nativeFrame === undefined ? { enabled: false, managedByEnv: false } : props.nativeFrame}
        nativeFrameNeedsRestart={props.nativeFrameNeedsRestart ?? false}
    onNativeFrameChange={onNativeFrameChange}
    onRelaunch={onRelaunch}
    onTailscaleHostname={async () => ({ hostname: "NomadVNC-test", applied: false })}
  />,
    );
  });
  return { root, onChange, onNativeFrameChange, onRelaunch };
}

describe("SettingsPanel", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
  });

  it("renders the defaults sections", () => {
    const { root } = mountPanel(container, {});
    try {
      expect(container.textContent).toContain("New Machines");
      expect(container.textContent).toContain("Viewer Defaults");
      expect(container.textContent).toContain("Password Storage");
      expect(container.textContent).toContain("Credits");
      const coffee = container.querySelector<HTMLAnchorElement>('a[href="https://buymeacoffee.com/greg.tech"]');
      expect(coffee?.textContent).toBe("Buy Me a Coffee");
      const port = container.querySelector<HTMLInputElement>("#settings-default-port");
      expect(port?.value).toBe("5900");
    } finally {
      act(() => root.unmount());
    }
  });

  it("propagates a default-port change", () => {
    const { root, onChange } = mountPanel(container, {});
    try {
      const port = container.querySelector<HTMLInputElement>("#settings-default-port");
      if (!port) {
        throw new Error("port input missing");
      }
      // Bypass React's value tracker so the input event reads as a real change.
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value",
      )?.set;
      if (!nativeSetter) {
        throw new Error("no native value setter");
      }
      act(() => {
        nativeSetter.call(port, "5901");
        port.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(onChange).toHaveBeenCalledWith({ defaultVncPort: 5901 });
    } finally {
      act(() => root.unmount());
    }
  });

  it("shows the secure-storage diagnostics, available and not", () => {
    const first = mountPanel(container, {
      secureStorage: { available: false, platform: "linux", hint: "Unlock your keyring." },
    });
    try {
      expect(container.textContent).toContain("Unavailable");
      expect(container.textContent).toContain("Unlock your keyring.");
    } finally {
      act(() => first.root.unmount());
    }

    const second = mountPanel(container, {
      secureStorage: { available: true, platform: "linux", backend: "kwallet5" },
    });
    try {
      expect(container.textContent).toContain("Available (kwallet5)");
    } finally {
      act(() => second.root.unmount());
    }
  });

  it("toggles the native-frame fallback", () => {
    const { root, onNativeFrameChange } = mountPanel(container, {});
    try {
      const label = Array.from(container.querySelectorAll("label")).find((l) =>
        l.textContent?.includes("Use Native Window Frame"),
      );
      const checkbox = label?.querySelector<HTMLInputElement>('input[type="checkbox"]');
      if (!checkbox) throw new Error("native-frame checkbox missing");
      expect(checkbox.checked).toBe(false);
      act(() => {
        checkbox.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(onNativeFrameChange).toHaveBeenCalledWith(true);
    } finally {
      act(() => root.unmount());
    }
  });

  it("disables the native-frame toggle when managed by the environment", () => {
    const { root } = mountPanel(container, {
      nativeFrame: { enabled: true, managedByEnv: true },
    });
    try {
      const label = Array.from(container.querySelectorAll("label")).find((l) =>
        l.textContent?.includes("Use Native Window Frame"),
      );
      const checkbox = label?.querySelector<HTMLInputElement>('input[type="checkbox"]');
      if (!checkbox) throw new Error("native-frame checkbox missing");
      expect(checkbox.disabled).toBe(true);
      expect(container.textContent).toContain("NOMADVNC_NATIVE_FRAME");
      expect(container.textContent).not.toContain("Restart NomadVNC");
    } finally {
      act(() => root.unmount());
    }
  });

  it("offers a restart when the frame change is not yet applied", () => {
    const { root, onRelaunch } = mountPanel(container, {
      nativeFrame: { enabled: true, managedByEnv: false },
      nativeFrameNeedsRestart: true,
    });
    try {
      const button = Array.from(container.querySelectorAll("button")).find((b) =>
        b.textContent?.includes("Restart NomadVNC"),
      );
      if (!button) throw new Error("restart button missing");
      act(() => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      expect(onRelaunch).toHaveBeenCalled();
    } finally {
      act(() => root.unmount());
    }
  });
});
