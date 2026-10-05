import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Collection, PeerDevice, SavedMachine } from "@nomadvnc/domain";
import { QuickConnect } from "./QuickConnect";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function createMachine(overrides: Partial<SavedMachine> = {}): SavedMachine {
  return {
    id: overrides.id ?? "machine-1",
    ownerMode: overrides.ownerMode ?? "guest",
    collectionId: overrides.collectionId,
    label: overrides.label ?? "Lab Desktop",
    tailscaleStableId: overrides.tailscaleStableId ?? "peer-1",
    dnsName: overrides.dnsName ?? "lab.tail.ts.net",
    lastKnownTailnetIp: overrides.lastKnownTailnetIp ?? "100.64.0.10",
    vncPort: overrides.vncPort ?? 5900,
    credentialMode: overrides.credentialMode ?? "prompt",
    createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-01-02T00:00:00.000Z",
    lastConnectedAt: overrides.lastConnectedAt,
  };
}

const PEERS: PeerDevice[] = [
  { stableId: "peer-1", displayName: "Lab", dnsName: "lab.tail.ts.net", tailnetIps: ["100.64.0.10"], online: true },
  { stableId: "peer-2", displayName: "Office", dnsName: "office.tail.ts.net", tailnetIps: ["100.64.0.20"], online: false },
];

const MACHINES: SavedMachine[] = [
  createMachine({ id: "a", label: "Lab Desktop", tailscaleStableId: "peer-1", credentialMode: "localSecure", lastConnectedAt: "2026-01-01T00:00:00.000Z" }),
  createMachine({ id: "b", label: "Office Mac", tailscaleStableId: "peer-2", dnsName: "office.tail.ts.net", credentialMode: "prompt", lastConnectedAt: "2026-01-03T00:00:00.000Z" }),
  createMachine({ id: "c", label: "Zulu Server", tailscaleStableId: "peer-1", credentialMode: "prompt" }),
];

function cardNames(container: ParentNode): string[] {
  return Array.from(container.querySelectorAll(".machine-name")).map((el) => el.textContent ?? "");
}

function setSearchValue(input: HTMLInputElement, value: string): void {
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

function setSelectValue(select: HTMLSelectElement, value: string): void {
  act(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

describe("QuickConnect search/filter/sort", () => {
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

  function renderList(): void {
    act(() => {
      root = createRoot(container);
      root.render(
        <QuickConnect
          machines={MACHINES}
          peers={PEERS}
          onConnect={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onSwitchToForm={vi.fn()}
        />,
      );
    });
  }

  function selectByLabel(label: string): HTMLSelectElement {
    const select = container.querySelector(`select[aria-label="${label}"]`);
    if (!select) {
      throw new Error(`No select with aria-label "${label}"`);
    }
    return select as HTMLSelectElement;
  }

  it("filters the list by search text", () => {
    renderList();
    expect(cardNames(container)).toHaveLength(3);

    const search = container.querySelector('input[aria-label="Search saved machines"]') as HTMLInputElement;
    setSearchValue(search, "office");
    expect(cardNames(container)).toEqual(["Office Mac"]);
    expect(container.querySelector(".section-count")?.textContent).toBe("1 of 3");
  });

  it("filters by online status and clears back to the full list", () => {
    renderList();
    setSelectValue(selectByLabel("Filter by status"), "online");
    expect(cardNames(container)).toEqual(["Lab Desktop", "Zulu Server"]);

    setSelectValue(selectByLabel("Filter by status"), "offline");
    expect(cardNames(container)).toEqual(["Office Mac"]);

    // Search with no hits shows the empty-filtered state with a clear action.
    const search = container.querySelector('input[aria-label="Search saved machines"]') as HTMLInputElement;
    setSearchValue(search, "no-such-machine");
    expect(container.textContent).toContain("No Machines Match");
    const clear = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Clear Search & Filters",
    ) as HTMLButtonElement;
    act(() => {
      clear.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(cardNames(container)).toHaveLength(3);
  });

  it("sorts by recently connected and online-first", () => {
    renderList();
    expect(cardNames(container)).toEqual(["Lab Desktop", "Office Mac", "Zulu Server"]);

    setSelectValue(selectByLabel("Sort machines"), "recent");
    expect(cardNames(container)).toEqual(["Office Mac", "Lab Desktop", "Zulu Server"]);

    setSelectValue(selectByLabel("Sort machines"), "online-first");
    expect(cardNames(container)).toEqual(["Lab Desktop", "Zulu Server", "Office Mac"]);
  });
});

describe("QuickConnect groups", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  const COLLECTIONS: Collection[] = [
    { id: "group-1", ownerMode: "guest", name: "Homelab", sortOrder: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  ];

  const GROUPED: SavedMachine[] = [
    createMachine({ id: "a", label: "Lab Desktop", tailscaleStableId: "peer-1", collectionId: "group-1" }),
    createMachine({ id: "b", label: "Office Mac", tailscaleStableId: "peer-2" }),
  ];

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

  function renderGrouped(onDeleteCollection = vi.fn()): ReturnType<typeof vi.fn> {
    act(() => {
      root = createRoot(container);
      root.render(
        <QuickConnect
          machines={GROUPED}
          peers={PEERS}
          collections={COLLECTIONS}
          onConnect={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onSwitchToForm={vi.fn()}
          onDeleteCollection={onDeleteCollection}
        />,
      );
    });
    return onDeleteCollection;
  }

  function selectByLabel(label: string): HTMLSelectElement {
    const select = container.querySelector(`select[aria-label="${label}"]`);
    if (!select) {
      throw new Error(`No select with aria-label "${label}"`);
    }
    return select as HTMLSelectElement;
  }

  it("filters the list by group", () => {
    renderGrouped();
    expect(cardNames(container)).toEqual(["Lab Desktop", "Office Mac"]);

    setSelectValue(selectByLabel("Filter by group"), "group-1");
    expect(cardNames(container)).toEqual(["Lab Desktop"]);

    setSelectValue(selectByLabel("Filter by group"), "ungrouped");
    expect(cardNames(container)).toEqual(["Office Mac"]);
  });

  it("deletes a group after confirmation without deleting machines", () => {
    const onDeleteCollection = renderGrouped();
    setSelectValue(selectByLabel("Filter by group"), "group-1");

    const deleteButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Delete Group",
    ) as HTMLButtonElement;
    act(() => {
      deleteButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const confirm = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Delete?",
    ) as HTMLButtonElement;
    act(() => {
      confirm.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(onDeleteCollection).toHaveBeenCalledWith(COLLECTIONS[0]);
  });
});

describe("QuickConnect sharing", () => {
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

  it("shows the Share button only for account machines and lists shared devices", () => {
    const onShare = vi.fn();
    act(() => {
      root = createRoot(container);
      root.render(
        <QuickConnect
          machines={[
            createMachine({ id: "a", label: "Cloud Box", ownerMode: "account" }),
            createMachine({ id: "b", label: "Local Box", ownerMode: "guest" }),
          ]}
          peers={PEERS}
          sharedDevices={[
            {
              id: "s-1", tailscaleStableId: "peer-9", vncPort: 5900, label: "Friend Box",
              sharedBy: "friend@example.test", permission: "connect",
              hasTailnetKey: true, grantedAt: "2026-02-01T00:00:00.000Z",
            },
          ]}
          onConnect={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onShare={onShare}
          isAccountMachine={(machine) => machine.ownerMode === "account"}
          onSwitchToForm={vi.fn()}
        />,
      );
    });

    const shareButtons = Array.from(container.querySelectorAll('button[title="Share Machine"]'));
    expect(shareButtons).toHaveLength(1);
    act(() => {
      shareButtons[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onShare).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));

    expect(container.textContent).toContain("Shared With Me");
    expect(container.textContent).toContain("Friend Box");
    expect(container.textContent).toContain("friend@example.test");
    expect(container.textContent).toContain("Key attached");
  });

  it("marks only the connecting machine's card while connecting", () => {
    act(() => {
      root = createRoot(container);
      root.render(
        <QuickConnect
          machines={MACHINES}
          peers={PEERS}
          connectingMachineId="a"
          onConnect={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onSwitchToForm={vi.fn()}
        />,
      );
    });

    const cards = Array.from(container.querySelectorAll(".machine-card"));
    expect(cards).toHaveLength(3);
    const connectingCards = cards.filter((card) => card.classList.contains("machine-card--connecting"));
    expect(connectingCards).toHaveLength(1);
    expect(connectingCards[0]?.querySelector(".machine-name")?.textContent).toBe("Lab Desktop");

    const connectButton = connectingCards[0]?.querySelector('button[title="Connect"]') as HTMLButtonElement | null;
    expect(connectButton?.disabled).toBe(true);
    expect(connectButton?.textContent).toContain("Connecting");
  });
});
