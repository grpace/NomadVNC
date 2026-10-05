import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendShareView, ShareGrantInput } from "../accountClient";
import { ShareDialog } from "./ShareDialog";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement;

function share(overrides: Partial<BackendShareView> = {}): BackendShareView {
  return {
    id: "share-1",
    deviceId: "server-9",
    granteeEmail: "bob@example.test",
    permission: "connect",
    hasTailnetKey: true,
    keyExpiresInDays: 20,
    createdAt: "2026-02-01T00:00:00.000Z",
    ...overrides,
  };
}

function renderDialog(overrides: Partial<Parameters<typeof ShareDialog>[0]> = {}) {
  const calls: Array<{ message: string; variant: string }> = [];
  const onGrant = vi.fn(async (_input: ShareGrantInput) => ({ inviteSent: true }));
  const onRekey = vi.fn(async (_shareId: string, _key: string, _expires: string) => {});
  const onClearKey = vi.fn(async (_shareId: string) => {});
  const onRevoke = vi.fn(async (_shareId: string) => {});
  const onClose = vi.fn();
  const props = {
    machineLabel: "Lab",
    shares: [] as BackendShareView[],
    loadingShares: false,
    onGrant,
    onRekey,
    onClearKey,
    onRevoke,
    onNotice: (message: string, variant: "info" | "success" | "error") => {
      calls.push({ message, variant });
    },
    onClose,
    ...overrides,
  };
  act(() => {
    root?.render(<ShareDialog {...props} />);
  });
  return { props, mocks: { onGrant, onRekey, onClearKey, onRevoke, onClose }, notices: calls };
}

function inputById(id: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) {
    throw new Error(`No input #${id}`);
  }
  return input;
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === text,
  );
  if (!button) {
    throw new Error(`No button "${text}"`);
  }
  return button as HTMLButtonElement;
}

function typeInto(input: HTMLInputElement, value: string): void {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function clickAsync(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container.remove();
});

describe("ShareDialog", () => {
  it("grants with a key and default 30-day expiry", async () => {
    const { mocks, notices } = renderDialog();
    typeInto(inputById("share-email"), "bob@example.test");
    typeInto(inputById("share-key"), "tskey-auth-abc");
    await clickAsync(buttonByText("Share"));
    expect(mocks.onGrant).toHaveBeenCalledTimes(1);
    const input = mocks.onGrant.mock.calls[0]?.[0] as ShareGrantInput;
    expect(input.email).toBe("bob@example.test");
    expect(input.tailnetAuthKey).toBe("tskey-auth-abc");
    const days = (new Date(input.keyExpiresAt as string).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThanOrEqual(30);
    expect(notices.some((call) => call.variant === "success")).toBe(true);
  });

  it("grants same-tailnet shares without a key", async () => {
    const { mocks } = renderDialog();
    typeInto(inputById("share-email"), "carol@example.test");
    const toggle = inputById("share-include-key");
    act(() => {
      toggle.click();
    });
    await act(async () => {});
    await clickAsync(buttonByText("Share"));
    expect(mocks.onGrant).toHaveBeenCalledWith({ email: "carol@example.test" });
  });

  it("validates email, key presence, and day ranges", async () => {
    const { mocks, notices } = renderDialog();
    await clickAsync(buttonByText("Share"));
    expect(mocks.onGrant).not.toHaveBeenCalled();

    typeInto(inputById("share-email"), "bob@example.test");
    await clickAsync(buttonByText("Share"));
    expect(mocks.onGrant).not.toHaveBeenCalled();
    expect(notices.some((call) => call.variant === "error")).toBe(true);

    typeInto(inputById("share-key"), "tskey-auth-abc");
    typeInto(inputById("share-days"), "500");
    await clickAsync(buttonByText("Share"));
    expect(mocks.onGrant).not.toHaveBeenCalled();
  });

  it("renders expiry states and revokes with two clicks", async () => {
    const { mocks } = renderDialog({
      shares: [
        share({ id: "s-ok", granteeEmail: "ok@example.test", keyExpiresInDays: 20 }),
        share({ id: "s-soon", granteeEmail: "soon@example.test", keyExpiresInDays: 3 }),
        share({ id: "s-dead", granteeEmail: "dead@example.test", keyExpiresInDays: -1 }),
        share({ id: "s-local", granteeEmail: "local@example.test", hasTailnetKey: false, keyExpiresInDays: null }),
      ],
    });
    expect(container.textContent).toContain("expires in 20d");
    expect(container.textContent).toContain("expires in 3d. Replace soon");
    expect(container.textContent).toContain("expired. Replace it");
    expect(container.textContent).toContain("Same-tailnet · never expires");

    await clickAsync(buttonByText("Revoke"));
    expect(mocks.onRevoke).not.toHaveBeenCalled();
    await clickAsync(buttonByText("Confirm"));
    expect(mocks.onRevoke).toHaveBeenCalledTimes(1);
  });

  it("replaces a key without a re-invite and removes keys", async () => {
    const { mocks, notices } = renderDialog({
      shares: [share({ id: "s-1", keyExpiresInDays: 2 })],
    });
    await clickAsync(buttonByText("Replace Key"));
    const keyInput = container.querySelector<HTMLInputElement>('input[aria-label="Fresh Tailscale auth key"]');
    expect(keyInput).not.toBeNull();
    typeInto(keyInput as HTMLInputElement, "tskey-auth-fresh");
    await clickAsync(buttonByText("Save Key"));
    expect(mocks.onRekey).toHaveBeenCalledTimes(1);
    const [shareId, key] = mocks.onRekey.mock.calls[0] as unknown as [string, string];
    expect(shareId).toBe("s-1");
    expect(key).toBe("tskey-auth-fresh");
    expect(notices.some((call) => call.message.includes("No re-invite"))).toBe(true);

    await clickAsync(buttonByText("Replace Key"));
    await clickAsync(buttonByText("Remove Key"));
    expect(mocks.onClearKey).toHaveBeenCalledWith("s-1");
  });
});
