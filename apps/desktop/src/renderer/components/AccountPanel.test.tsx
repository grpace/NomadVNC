import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountPanel } from "./AccountPanel";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement;

function notices() {
  const calls: Array<{ message: string; variant: string }> = [];
  return {
    calls,
    onNotice: (message: string, variant: "info" | "success" | "error") => {
      calls.push({ message, variant });
    },
  };
}

function renderPanel(overrides: Partial<Parameters<typeof AccountPanel>[0]> = {}) {
  const spy = notices();
  const props = {
    session: null,
    baseUrl: "http://localhost:3200",
    lastSyncAt: null,
    pendingUploadCount: 0,
    pendingUploadEmail: null,
    onBaseUrlChange: vi.fn(),
    onRequestLink: vi.fn(async () => {}),
    onConsumeLink: vi.fn(async () => {}),
    onSignOut: vi.fn(async () => {}),
    onDeleteAccount: vi.fn(async () => {}),
    onSyncNow: vi.fn(async () => {}),
    onNotice: spy.onNotice,
    ...overrides,
  };
  act(() => {
    root?.render(<AccountPanel {...props} />);
  });
  return { props, spy };
}

function inputById(id: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) {
    throw new Error(`No input #${id}`);
  }
  return input;
}

function buttonByLabel(label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === label,
  );
  if (!button) {
    throw new Error(`No button "${label}"`);
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

function click(button: HTMLButtonElement): void {
  act(() => {
    button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function flush(): Promise<void> {
  await act(async () => {});
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

describe("AccountPanel", () => {
  it("sends the sign-in link when Enter is pressed in the email field", async () => {
    const { props } = renderPanel();
    typeInto(inputById("account-email"), "alice@example.test");
    const form = inputById("account-email").closest("form");
    act(() => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(props.onRequestLink).toHaveBeenCalledWith("alice@example.test");
  });

  it("signs in when Enter is pressed in the pasted-link field", async () => {
    const { props } = renderPanel();
    typeInto(inputById("account-link"), "nomadvnc://auth/callback?token=tok1234567890abcd");
    const form = inputById("account-link").closest("form");
    act(() => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(props.onConsumeLink).toHaveBeenCalledWith("tok1234567890abcd");
  });

  it("requests a magic link and reports success", async () => {
    const { props, spy } = renderPanel();
    typeInto(inputById("account-email"), "alice@example.test");
    click(buttonByLabel("Email Me a Sign-In Link"));
    await flush();
    expect(props.onRequestLink).toHaveBeenCalledWith("alice@example.test");
    expect(spy.calls.some((call) => call.variant === "success")).toBe(true);
  });

  it("consumes a pasted link and surfaces failures", async () => {
    const { props, spy } = renderPanel({
      onConsumeLink: vi.fn(async () => {
        throw new Error("Invalid or expired link");
      }),
    });
    typeInto(inputById("account-link"), "https://app.example.test/auth/verify?token=tok1234567890abcd");
    click(buttonByLabel("Sign In with This Link"));
    await flush();
    expect(props.onConsumeLink).toHaveBeenCalledWith("tok1234567890abcd");

    typeInto(inputById("account-link"), "junk!!");
    click(buttonByLabel("Sign In with This Link"));
    await flush();
    expect(spy.calls.some((call) => call.variant === "error")).toBe(true);
  });

  it("keeps the account page about accounts, and shows the session when signed in", async () => {
    renderPanel();
    expect(container.textContent).not.toContain("Tailscale is optional");

    const signOut = vi.fn(async () => {});
    const syncNow = vi.fn(async () => {});
    renderPanel({
      session: { token: "t", email: "alice@example.test" },
      lastSyncAt: "2026-09-10T12:00:00.000Z",
      onSignOut: signOut,
      onSyncNow: syncNow,
    });
    expect(container.textContent).toContain("alice@example.test");
    expect(container.textContent).toContain("Last synced");
    click(buttonByLabel("Sync Now"));
    await flush();
    expect(syncNow).toHaveBeenCalled();
    click(buttonByLabel("Sign Out of Nomad Account"));
    await flush();
    expect(signOut).toHaveBeenCalled();
  });

  it("rejects a bad server address without saving it", () => {
    const { props, spy } = renderPanel();
    const server = inputById("account-server");
    typeInto(server, "nota-url");
    act(() => {
      // React's onBlur listens for focusout at the root.
      server.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(props.onBaseUrlChange).not.toHaveBeenCalled();
    expect(spy.calls.some((call) => call.variant === "error")).toBe(true);
  });

  it("surfaces pending uploads on the signed-out view", () => {
    renderPanel({ pendingUploadCount: 3, pendingUploadEmail: "alice@example.test" });
    const notice = container.querySelector('[data-testid="account-pending-uploads"]');
    expect(notice?.textContent).toContain("3 local machines");
    expect(notice?.textContent).toContain("alice@example.test");
  });

  it("stays quiet about pending uploads when there are none", () => {
    renderPanel({ pendingUploadCount: 0, pendingUploadEmail: "alice@example.test" });
    expect(container.querySelector('[data-testid="account-pending-uploads"]')).toBeNull();
    renderPanel({ pendingUploadCount: 2, pendingUploadEmail: null });
    expect(container.querySelector('[data-testid="account-pending-uploads"]')).toBeNull();
  });
});

describe("account deletion", () => {
  const session = { token: "jwt", email: "me@example.test" };

  it("asks for confirmation before deleting", async () => {
    const { props } = renderPanel({ session });
    click(buttonByLabel("Delete Account…"));
    expect(props.onDeleteAccount).not.toHaveBeenCalled();
    click(buttonByLabel("Permanently Delete me@example.test"));
    await flush();
    expect(props.onDeleteAccount).toHaveBeenCalledTimes(1);
  });

  it("can back out of the confirmation", () => {
    const { props } = renderPanel({ session });
    click(buttonByLabel("Delete Account…"));
    click(buttonByLabel("Cancel"));
    expect(buttonByLabel("Delete Account…")).toBeTruthy();
    expect(props.onDeleteAccount).not.toHaveBeenCalled();
  });

  it("reports a failed deletion instead of pretending it worked", async () => {
    const { spy } = renderPanel({
      session,
      onDeleteAccount: vi.fn(async () => {
        throw new Error("Server unreachable");
      }),
    });
    click(buttonByLabel("Delete Account…"));
    click(buttonByLabel("Permanently Delete me@example.test"));
    await flush();
    expect(spy.calls).toContainEqual({ message: "Server unreachable", variant: "error" });
  });
});
