/**
 * Saving an added or edited account device. The server keys devices on
 * identity + port, so an edit that keeps the address keeps the identity
 * (tailnet devices keep their stable id). A new address or port is a new
 * server record: the saved password moves to it and the old record goes.
 * A shared device can't move, since its shares would be lost.
 */

import type { AccountClient } from "./accountClient";
import { savedDeviceHost, type SavedDeviceLike } from "./deviceUi";
import { deviceIdentityForAddress } from "./localDevices";

export interface AccountDeviceFields {
  label: string;
  host: string;
  port: number;
  collectionName: string;
  vncUsername: string;
  /** Empty keeps the saved password. */
  password: string;
}

type DeviceClient = Pick<
  AccountClient,
  "listShares" | "upsertDevice" | "setDeviceCredential" | "getDeviceCredential" | "deleteDevice"
>;

const IPV4 = /^\d+\.\d+\.\d+\.\d+$/;

export async function saveAccountDevice(
  client: DeviceClient,
  editing: (SavedDeviceLike & { hasCredential?: boolean }) | null,
  fields: AccountDeviceFields,
): Promise<void> {
  const host = fields.host.trim();
  const sameAddress = editing !== null && savedDeviceHost(editing) === host;
  const moves = editing !== null && (!sameAddress || editing.vncPort !== fields.port);
  if (editing && moves) {
    const shares = await client.listShares(editing.id);
    if (shares.length > 0) {
      throw new Error("This computer is shared. Remove its shares before changing the address or port.");
    }
  }
  const device = await client.upsertDevice({
    label: fields.label.trim(),
    // Same identity rule as desktop: LAN hosts are manual:<host>, tailnet
    // names stay as-is so they keep routing via the tailnet.
    tailscaleStableId: sameAddress && editing ? editing.tailscaleStableId : deviceIdentityForAddress(host),
    dnsName: sameAddress && editing ? editing.dnsName : host,
    lastKnownIp: sameAddress && editing ? editing.lastKnownIp : IPV4.test(host) ? host : undefined,
    vncPort: fields.port,
    collectionName: fields.collectionName.trim() || undefined,
    vncUsername: fields.vncUsername.trim(),
  });
  if (fields.password) {
    await client.setDeviceCredential(device.id, fields.password);
  } else if (editing && moves && editing.hasCredential) {
    const saved = await client.getDeviceCredential(editing.id);
    if (saved != null) {
      await client.setDeviceCredential(device.id, saved);
    }
  }
  if (editing && moves) {
    await client.deleteDevice(editing.id);
  }
}
