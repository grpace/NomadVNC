import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HeadlessSetup } from "./HeadlessSetup";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe("HeadlessSetup", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let writeClipboard: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeClipboard = vi.fn(async () => {});
    (window as unknown as Record<string, unknown>).nomadNative = { writeClipboard };
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
      root.render(<HeadlessSetup />);
    });
  }

  function toggle(): void {
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Setting Up a Headless Server?",
    ) as HTMLButtonElement;
    act(() => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("stays collapsed until asked", () => {
    renderGuide();
    expect(container.querySelector(".headless-setup__steps")).toBeNull();

    toggle();
    expect(container.querySelectorAll(".headless-setup__step")).toHaveLength(5);
    expect(container.textContent).toContain("5901");
  });

  it("copies a step's commands to the clipboard", async () => {
    renderGuide();
    toggle();

    const copyButtons = Array.from(container.querySelectorAll("button")).filter(
      (button) => button.textContent === "Copy",
    );
    const tailscaleCopy = copyButtons.find((button) =>
      (button.getAttribute("title") ?? "").includes("Join the server"),
    );
    await act(async () => {
      tailscaleCopy?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(writeClipboard).toHaveBeenCalledTimes(1);
    const copied = String(writeClipboard.mock.calls[0]?.[0] ?? "");
    expect(copied).toContain("tailscale up");
    expect(container.textContent).toContain("Copied");
  });
});
