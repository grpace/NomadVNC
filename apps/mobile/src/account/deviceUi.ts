/**
 * Pure helpers for the saved-devices UI: host resolution, tailnet-vs-direct
 * routing for saved devices, collection grouping, and email validation.
 * Mirrors the platform-contracts rule that tailnet-only targets
 * (100.64.0.0/10, MagicDNS *.ts.net) go through the tailnet while anything
 * else typed by the user dials direct over the OS network.
 */

import { isTailnetAddress } from "@nomadvnc/domain";
import type { StartVncSessionInput } from "@nomadvnc/platform-contracts";
import type { BackendDeviceView, BackendSharedDeviceView } from "./accountClient";

export type SavedDeviceLike = Pick<
  BackendDeviceView | BackendSharedDeviceView,
  "id" | "label" | "dnsName" | "lastKnownIp" | "vncPort" | "collectionName" | "tailscaleStableId"
>;

export type ConnectInputResult =
  | { ok: true; input: StartVncSessionInput }
  | { ok: false; error: string };

/** Best reachable host for a saved device: DNS name, then last known IP. */
export function savedDeviceHost(device: SavedDeviceLike): string {
  return (device.dnsName ?? device.lastKnownIp ?? device.tailscaleStableId ?? "").trim();
}

/** True when the host can only be reached through the tailnet (shared domain rule). */
export const isTailnetHost = isTailnetAddress;

/**
 * Builds the native session input for a saved device. Tailnet hosts go
 * through the tailnet (needs login — the sidecar errors clearly when it
 * isn't available); LAN hosts dial direct over the OS network.
 */
export function buildSavedDeviceInput(
  device: SavedDeviceLike,
  sessionToken: string,
): ConnectInputResult {
  const host = savedDeviceHost(device);
  if (!host) {
    return { ok: false, error: "That device has no reachable address" };
  }
  if (!Number.isInteger(device.vncPort) || device.vncPort < 1 || device.vncPort > 65535) {
    return { ok: false, error: "That device has an invalid saved port" };
  }
  const input: StartVncSessionInput = {
    host,
    port: device.vncPort,
    sessionToken,
  };
  if (!isTailnetHost(host)) {
    input.direct = true;
  }
  return { ok: true, input };
}

export interface DeviceGroup<T extends SavedDeviceLike = SavedDeviceLike> {
  name: string;
  devices: T[];
}

const UNGROUPED = "Ungrouped";

/**
 * Groups devices by collection name; devices without one land in
 * "Ungrouped" (always last). Groups and devices are sorted by label.
 */
export function groupDevicesByCollection<T extends SavedDeviceLike>(
  devices: T[],
): DeviceGroup<T>[] {
  const map = new Map<string, T[]>();
  for (const device of devices) {
    const name = device.collectionName?.trim() || UNGROUPED;
    const list = map.get(name);
    if (list) {
      list.push(device);
    } else {
      map.set(name, [device]);
    }
  }
  const groups: DeviceGroup<T>[] = [...map.entries()].map(([name, list]) => ({
    name,
    devices: [...list].sort((a, b) => a.label.localeCompare(b.label)),
  }));
  groups.sort((a, b) => {
    if (a.name === UNGROUPED) return 1;
    if (b.name === UNGROUPED) return -1;
    return a.name.localeCompare(b.name);
  });
  return groups;
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
