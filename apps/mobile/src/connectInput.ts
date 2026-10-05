import type { PeerDevice } from "@nomadvnc/domain";
import type { StartVncSessionInput } from "@nomadvnc/platform-contracts";

export interface ManualConnectSelection {
  peer?: PeerDevice | null;
  /** User-typed host/IP — the local-first path. */
  host?: string;
  port: number;
}

export type ConnectInputResult =
  | { ok: true; input: StartVncSessionInput }
  | { ok: false; error: string };

/**
 * Builds the session input for a connect attempt. A typed host/IP always
 * wins and is marked `direct` so the engine dials via the OS network
 * without requiring tailnet login (local-first, mirrors desktop).
 * Otherwise a selected tailnet peer is used.
 */
export function buildConnectInput(
  selection: ManualConnectSelection,
  sessionToken: string,
): ConnectInputResult {
  const host = (selection.host ?? "").trim();
  if (host) {
    if (!Number.isInteger(selection.port) || selection.port < 1 || selection.port > 65535) {
      return { ok: false, error: "Enter a valid VNC port (1–65535)" };
    }
    return {
      ok: true,
      input: { host, port: selection.port, sessionToken, direct: true },
    };
  }
  const peer = selection.peer;
  if (!peer) {
    return { ok: false, error: "Choose a device or type a host/IP first" };
  }
  const peerHost = peer.dnsName ?? peer.tailnetIps[0];
  if (!peerHost) {
    return { ok: false, error: "That device has no reachable address" };
  }
  if (!Number.isInteger(selection.port) || selection.port < 1 || selection.port > 65535) {
    return { ok: false, error: "Enter a valid VNC port (1–65535)" };
  }
  return {
    ok: true,
    input: { host: peerHost, port: selection.port, sessionToken },
  };
}
