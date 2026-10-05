import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Collection } from "@nomadvnc/domain";
import { ConnectionForm } from "./ConnectionForm";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const COLLECTIONS: Collection[] = [
  { id: "group-1", ownerMode: "guest", name: "Homelab", sortOrder: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
];

function setSelectValue(select: HTMLSelectElement, value: string): void {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  act(() => {
    if (setter) {
      setter.call(input, value);
    } else {
      input.value = value;
    }
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("ConnectionForm groups", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
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
  });

  function renderForm(overrides: Record<string, unknown> = {}) {
    const props = {
      peers: [],
      selectedPeerId: "",
      machineLabel: "",
      vncPort: "5900",
      vncUsername: "",
      password: "",
      manualHost: "",
      collections: COLLECTIONS,
      selectedCollectionId: "",
      savePasswordSecurely: false,
      secureStorageAvailable: false,
      isRefreshing: false,
      isLoggedIn: false,
      isEditing: false,
      onPeerChange: vi.fn(),
      onManualHostChange: vi.fn(),
      onMachineLabelChange: vi.fn(),
      onVncPortChange: vi.fn(),
      onVncUsernameChange: vi.fn(),
      onPasswordChange: vi.fn(),
      onCollectionChange: vi.fn(),
      onCreateCollection: vi.fn(() => null),
      onSavePasswordSecurelyChange: vi.fn(),
      onRefresh: vi.fn(),
      onSave: vi.fn(),
      onConnect: vi.fn(),
      ...overrides,
    };
    act(() => {
      root = createRoot(container);
      root.render(<ConnectionForm {...props} />);
    });
    return props;
  }

  it("assigns an existing group through the select", () => {
    const props = renderForm();
    const select = container.querySelector("#machine-group") as HTMLSelectElement;
    setSelectValue(select, "group-1");
    expect(props.onCollectionChange).toHaveBeenCalledWith("group-1");
  });

  it("creates a group and selects it", () => {
    const created: Collection = { ...COLLECTIONS[0] as Collection, id: "group-2", name: "Office" };
    const props = renderForm({ onCreateCollection: vi.fn(() => created) });

    const input = container.querySelector('input[aria-label="New group name"]') as HTMLInputElement;
    setInputValue(input, "Office");
    const add = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Add",
    ) as HTMLButtonElement;
    act(() => {
      add.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(props.onCreateCollection).toHaveBeenCalledWith("Office");
    expect(props.onCollectionChange).toHaveBeenCalledWith("group-2");
  });

  it("shows a hint when the group name is rejected", () => {
    renderForm({ onCreateCollection: vi.fn(() => null) });

    const input = container.querySelector('input[aria-label="New group name"]') as HTMLInputElement;
    setInputValue(input, "Homelab");
    const add = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Add",
    ) as HTMLButtonElement;
    act(() => {
      add.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain("Enter a unique group name.");
  });

  it("connects when Enter is pressed in a field", () => {
    const props = renderForm({ isLoggedIn: true, manualHost: "192.168.1.20" });
    const form = container.querySelector("form.connection-form");
    act(() => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(props.onConnect).toHaveBeenCalledOnce();
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it("saves when Enter is pressed while editing", () => {
    const props = renderForm({ isEditing: true });
    const form = container.querySelector("form.connection-form");
    act(() => {
      form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(props.onSave).toHaveBeenCalledOnce();
    expect(props.onConnect).not.toHaveBeenCalled();
  });

  it("leads with the address field and hides the empty device picker when signed out", () => {
    const props = renderForm({ isLoggedIn: false });

    const input = container.querySelector("#manual-host") as HTMLInputElement;
    expect(input).not.toBeNull();
    setInputValue(input, "192.168.1.20");
    expect(props.onManualHostChange).toHaveBeenCalledWith("192.168.1.20");
    expect(container.textContent).toContain("Host or IP Address");
    expect(container.querySelector("#peer-select")).toBeNull();
    // Refresh would start a Tailscale login while signed out.
    expect(container.querySelector('[aria-label="Refresh devices"]')).toBeNull();
  });

  it("offers the device picker first, with the address as an override, on the tailnet", () => {
    renderForm({ isLoggedIn: true });

    expect(container.querySelector("#peer-select")).not.toBeNull();
    expect(container.textContent).toContain("Or Enter an Address");
    expect(container.textContent).toContain("Used instead of the device above");
  });
});
