/**
 * Server-authoritative account sync (H4b). Rules, per the no-migration
 * decision (no real users are owed a merge):
 *
 * - First sign-in with an account uploads every local machine (metadata via
 *   plain upsert, keyring passwords pushed alongside), then downloads.
 * - From then on the server list is the library: login, boot-with-session,
 *   and Sync-now all download + replace. Local storage is the offline cache.
 * - Saves and deletes while signed in go through the server FIRST; a failed
 *   push aborts the local change so the cache can never silently diverge.
 * - The server has no VNC-username field, so downloads preserve local-only
 *   overlays (`vncUsername`, `lastConnectedAt`) matched on stable-id + port.
 * - Sharing management runs behind the tailnet gate (H4d): a *known*
 *   logged-out tailnet refuses with guidance. Unknown state (boot, before
 *   the first tailnet sample) proceeds — absence of evidence is not evidence.
 *   Sync/save/delete/credential-fetch are plain HTTPS account calls and
 *   work without the tailnet (Tailscale optional since 2026-09-10).
 */

import type { Collection, SavedMachine } from "@nomadvnc/domain";
import type {
  BackendDeviceUpsert,
  BackendDeviceView,
} from "./accountClient";

/** Structural client surface the engine needs (AccountClient satisfies it). */
export interface SyncClient {
  listDevices(): Promise<BackendDeviceView[]>;
  upsertDevice(input: BackendDeviceUpsert): Promise<BackendDeviceView>;
  setDeviceCredential(deviceId: string, password: string): Promise<void>;
  getDeviceCredential(deviceId: string): Promise<string | null>;
  deleteDevice(deviceId: string): Promise<void>;
}

export type KeyringPasswordReader = (machineId: string) => Promise<string | null>;

/** Server identity of a machine: stable tailnet id + VNC port. */
export function machineMatchKey(machine: Pick<SavedMachine, "tailscaleStableId" | "vncPort">): string {
  return `${machine.tailscaleStableId}:${machine.vncPort}`;
}

function collectionNameFor(collections: Collection[], collectionId: string | undefined): string | undefined {
  if (!collectionId) {
    return undefined;
  }
  return collections.find((collection) => collection.id === collectionId)?.name;
}

export function toDeviceUpsert(machine: SavedMachine, collections: Collection[]): BackendDeviceUpsert {
  return {
    label: machine.label,
    tailscaleStableId: machine.tailscaleStableId,
    dnsName: machine.dnsName || undefined,
    lastKnownIp: machine.lastKnownTailnetIp || undefined,
    vncPort: machine.vncPort,
    collectionName: collectionNameFor(collections, machine.collectionId),
  };
}

export function fromDeviceView(view: BackendDeviceView, collections: Collection[]): SavedMachine {
  const collectionId = view.collectionName
    ? collections.find((collection) => collection.name === view.collectionName)?.id
    : undefined;
  return {
    id: view.id,
    ownerMode: "account",
    collectionId,
    label: view.label,
    tailscaleStableId: view.tailscaleStableId,
    dnsName: view.dnsName,
    lastKnownTailnetIp: view.lastKnownIp,
    vncPort: view.vncPort,
    credentialMode: view.hasCredential ? "cloudSecure" : "prompt",
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

/**
 * Replaces the local library with the server list, keeping local-only
 * overlays (VNC username, last-connected stamp) matched on stable-id + port.
 */
export function applyServerLibrary(
  locals: SavedMachine[],
  views: BackendDeviceView[],
  collections: Collection[],
): SavedMachine[] {
  const overlays = new Map(
    locals.map((machine) => [
      machineMatchKey(machine),
      { vncUsername: machine.vncUsername, lastConnectedAt: machine.lastConnectedAt },
    ]),
  );
  return views
    .map((view) => {
      const machine = fromDeviceView(view, collections);
      const overlay = overlays.get(machineMatchKey(machine));
      if (overlay?.vncUsername) {
        machine.vncUsername = overlay.vncUsername;
      }
      if (overlay?.lastConnectedAt) {
        machine.lastConnectedAt = overlay.lastConnectedAt;
      }
      return machine;
    })
    .sort((left, right) => left.label.localeCompare(right.label));
}

export async function downloadAccountLibrary(
  client: SyncClient,
  locals: SavedMachine[],
  collections: Collection[],
): Promise<SavedMachine[]> {
  const views = await client.listDevices();
  return applyServerLibrary(locals, views, collections);
}

export interface LibraryUploadResult {
  uploaded: number;
  /** Labels whose keyring password was unreadable: metadata synced, password left local-only. */
  metadataOnly: string[];
  failed: Array<{ id: string; label: string; error: string }>;
}

export async function uploadLocalLibrary(
  client: SyncClient,
  locals: SavedMachine[],
  collections: Collection[],
  getPassword: KeyringPasswordReader,
): Promise<LibraryUploadResult> {
  const result: LibraryUploadResult = { uploaded: 0, metadataOnly: [], failed: [] };
  for (const machine of locals) {
    try {
      const view = await client.upsertDevice(toDeviceUpsert(machine, collections));
      if (machine.credentialMode === "localSecure") {
        const password = await getPassword(machine.id).catch(() => null);
        if (password) {
          await client.setDeviceCredential(view.id, password);
        } else {
          result.metadataOnly.push(machine.label);
        }
      }
      result.uploaded += 1;
    } catch (error) {
      result.failed.push({
        id: machine.id,
        label: machine.label,
        error: error instanceof Error ? error.message : "Upload failed",
      });
    }
  }
  return result;
}

/** Pushes one save through the server; resolves with the server view (source of truth for ids). */
export async function pushSavedMachine(
  client: SyncClient,
  machine: SavedMachine,
  collections: Collection[],
  password?: string,
): Promise<BackendDeviceView> {
  const view = await client.upsertDevice(toDeviceUpsert(machine, collections));
  if (password) {
    await client.setDeviceCredential(view.id, password);
  }
  return view;
}

// --- Tailnet gate (H4d) ---

export interface TailnetGateState {
  loggedIn: boolean;
}

/**
 * Returns a guidance message when the tailnet is *known* logged out, else
 * null (proceed). Unknown state (null, e.g. boot before the first tailnet
 * sample) proceeds: the gate blocks certainty, not uncertainty.
 *
 * Scope (2026-09-10): the gate applies ONLY to sharing management. Sync,
 * save, delete, and synced-credential fetch are plain HTTPS account calls
 * and work without the tailnet — Tailscale is optional. Sharing keeps the
 * gate because it releases credentials to other people and its key-passing
 * transport is tailnet-native.
 */
export function tailnetGateMessage(
  tailnet: TailnetGateState | null | undefined,
  action: string,
): string | null {
  if (!tailnet || tailnet.loggedIn) {
    return null;
  }
  return `Sign in to Tailscale ${action}. The Nomad account needs the tailnet.`;
}

// --- First-upload marker (per account email) ---

const SYNC_STORAGE_KEY = "nomadvnc.desktop.accountSync.v1";

export interface AccountSyncState {
  uploadedForEmail: string | null;
  /**
   * Last account email seen on this device. Survives sign-out (unlike
   * uploadedForEmail) so the UI can surface pending uploads for a returning
   * user instead of treating them as never-had-an-account.
   */
  lastAccountEmail: string | null;
}

export function loadSyncState(): AccountSyncState {
  try {
    const raw = window.localStorage.getItem(SYNC_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AccountSyncState>;
      if (parsed.uploadedForEmail === null || typeof parsed.uploadedForEmail === "string") {
        return {
          uploadedForEmail: parsed.uploadedForEmail,
          lastAccountEmail:
            typeof parsed.lastAccountEmail === "string" ? parsed.lastAccountEmail : null,
        };
      }
    }
  } catch {
    // Corrupt storage means "not uploaded yet" — safe direction.
  }
  return { uploadedForEmail: null, lastAccountEmail: null };
}

export function persistSyncState(state: AccountSyncState): void {
  window.localStorage.setItem(SYNC_STORAGE_KEY, JSON.stringify(state));
}
