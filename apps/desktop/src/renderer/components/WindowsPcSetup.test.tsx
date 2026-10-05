import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WindowsPcSetup } from "./WindowsPcSetup";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe("WindowsPcSetup", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    (window as unknown as Record<string, unknown>).nomadNative = {
      writeClipboard: vi.fn(async () => {}),
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

  function renderGuide(): void {
    act(() => {
      root = createRoot(container);
      root.render(<WindowsPcSetup />);
    });
  }

  function toggle(): void {
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Setting Up a Windows PC?",
    ) as HTMLButtonElement;
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("stays collapsed until asked", () => {
    renderGuide();
    expect(container.querySelector(".headless-setup__steps")).toBeNull();

    toggle();
    expect(container.querySelectorAll(".headless-setup__step")).toHaveLength(4);
    expect(container.textContent).toContain("5900");
  });

  it("describes NomadVNC Host and has no shell commands to copy", () => {
    renderGuide();
    toggle();

    expect(container.textContent).toContain("NomadVNC Host");
    expect(container.textContent).toContain("5900");
    expect(container.textContent).toContain("Any VPN");
    expect(container.textContent).toContain("Disable Key Expiry");
    expect(container.textContent).toContain("silent install");
    const copyButtons = Array.from(container.querySelectorAll("button")).filter(
      (button) => button.textContent === "Copy",
    );
    expect(copyButtons).toHaveLength(0);
  });
});
