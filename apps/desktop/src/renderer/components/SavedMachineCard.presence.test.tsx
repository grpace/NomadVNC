import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeerDevice, SavedMachine } from "@nomadvnc/domain";
import { SavedMachineCard } from "./SavedMachineCard";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function createMachine(overrides: Partial<SavedMachine> = {}): SavedMachine {
  return {
    id: "machine-1",
    ownerMode: "guest",
    label: "Lab Desktop",
    tailscaleStableId: "peer-1",
    dnsName: "lab.tail.ts.net",
    lastKnownTailnetIp: "100.64.0.10",
    vncPort: 5900,
    credentialMode: "prompt",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("SavedMachineCard presence", () => {
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

  function renderCard(machine: SavedMachine, peers: PeerDevice[], isActive = false): void {
    act(() => {
      root = createRoot(container);
      root.render(
        <SavedMachineCard
          machine={machine}
          peers={peers}
          isActive={isActive}
          isConnecting={false}
          onConnect={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
        />,
      );
    });
  }

  function metaText(): string {
    return container.querySelector(".machine-meta")?.textContent ?? "";
  }

  it("shows last-seen for an offline peer", () => {
    const lastSeen = new Date(Date.now() - 5 * 60_000).toISOString();
    renderCard(createMachine(), [
      {
        stableId: "peer-1",
        displayName: "Lab",
        dnsName: "lab.tail.ts.net",
        tailnetIps: ["100.64.0.10"],
        online: false,
        lastSeen,
      },
    ]);

    expect(metaText()).toContain("Last seen 5m ago");
    expect(container.querySelector(".machine-icon-dot--offline")).not.toBeNull();
  });

  it("shows a not-on-tailnet note when the peer is absent", () => {
    renderCard(createMachine({ dnsName: undefined, lastKnownTailnetIp: undefined }), []);

    expect(metaText()).toBe("Not on Tailnet. Check Tailscale");
  });

  it("keeps the cached host alongside the not-on-tailnet note", () => {
    renderCard(createMachine(), []);

    expect(metaText()).toBe("lab.tail.ts.net · Not on Tailnet");
  });

  it("shows the live session instead of never-connected", () => {
    renderCard(createMachine({ dnsName: undefined, lastKnownTailnetIp: "127.0.0.1", tailscaleStableId: "manual:127.0.0.1" }), [], true);

    expect(metaText()).toBe("127.0.0.1 · Connected");
    expect(container.textContent).toContain("Asks Each Time");
  });
});
