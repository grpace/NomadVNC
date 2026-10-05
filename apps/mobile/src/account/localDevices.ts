/**
 * Saved devices for local mode (no Nomad account): kept on this phone only.
 * Metadata lives in app storage; each password goes to the OS keychain via
 * the native secure-storage bridge (`vnc-password:<id>`), never into the
 * metadata. Same shape as account devices so one list UI serves both.
 */

import { isTailnetAddress, manualStableId } from "@nomadvnc/domain";
import { NomadNativeModule } from "../native/NomadNativeModule";
import type { SavedDeviceLike } from "./deviceUi";

export type LocalDevice = SavedDeviceLike & { hasCredential: boolean };

export interface LocalDeviceInput {
  label: string;
  host: string;
  port: number;
  collectionName?: string;
}

const STORAGE_KEY = "nomadvnc.mobile.localDevices.v1";
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Tailnet names keep the host as identity (they route via the tailnet); LAN hosts are `manual:<host>`. */
export function deviceIdentityForAddress(host: string): string {
  return isTailnetAddress(host) ? host.trim() : manualStableId(host);
}

export function sanitizeLocalDevices(raw: unknown): LocalDevice[] {
  if (!Array.isArray(raw)) return [];
  const out: LocalDevice[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || typeof e.label !== "string" || typeof e.tailscaleStableId !== "string") continue;
    if (typeof e.vncPort !== "number" || !Number.isInteger(e.vncPort) || e.vncPort < 1 || e.vncPort > 65535) continue;
    out.push({
      id: e.id,
      label: e.label,
      tailscaleStableId: e.tailscaleStableId,
      dnsName: typeof e.dnsName === "string" ? e.dnsName : undefined,
      lastKnownIp: typeof e.lastKnownIp === "string" ? e.lastKnownIp : undefined,
      vncPort: e.vncPort,
      collectionName: typeof e.collectionName === "string" && e.collectionName ? e.collectionName : undefined,
      hasCredential: e.hasCredential === true,
    });
  }
  return out;
}

/** Adds a device, or updates the one with the same address and port. Pure. */
export function upsertLocalDevice(
  devices: LocalDevice[],
  input: LocalDeviceInput,
  newId: () => string,
): { devices: LocalDevice[]; device: LocalDevice } {
  const host = input.host.trim();
  const identity = deviceIdentityForAddress(host);
  const existing = devices.find((d) => d.tailscaleStableId === identity && d.vncPort === input.port);
  const device: LocalDevice = {
    id: existing?.id ?? newId(),
    label: input.label.trim(),
    tailscaleStableId: identity,
    dnsName: IPV4.test(host) ? undefined : host,
    lastKnownIp: IPV4.test(host) ? host : undefined,
    vncPort: input.port,
    collectionName: input.collectionName?.trim() || undefined,
    hasCredential: existing?.hasCredential ?? false,
  };
  const rest = devices.filter((d) => d.id !== device.id);
  return { devices: [...rest, device], device };
}

export function setLocalCredentialFlag(devices: LocalDevice[], id: string, hasCredential: boolean): LocalDevice[] {
  return devices.map((d) => (d.id === id ? { ...d, hasCredential } : d));
}

/** Not security-sensitive (a local list key), so no crypto RNG is needed. */
export function newLocalDeviceId(): string {
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function loadLocalDevices(): Promise<LocalDevice[]> {
  try {
    const raw = await NomadNativeModule.storageGetItem(STORAGE_KEY);
    return raw ? sanitizeLocalDevices(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export async function saveLocalDevices(devices: LocalDevice[]): Promise<void> {
  await NomadNativeModule.storageSetItem(STORAGE_KEY, JSON.stringify(devices));
}
