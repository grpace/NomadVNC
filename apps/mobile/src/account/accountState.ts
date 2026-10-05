/**
 * Framework-free Nomad account state for mobile. Holds the session, the
 * typed backend client, synced devices, and account server config; the
 * React provider (`AccountContext.tsx`) is a thin subscription wrapper so
 * all of this logic is unit-testable under vitest without a renderer.
 *
 * The JWT lives in the OS secure enclave (Keychain/Keystore) via the
 * injected SecureStore — never in plaintext. A stale token fails closed:
 * the first 401 from the backend signs the user out locally.
 */

import {
  AccountApiError,
  AccountClient,
  type BackendDeviceView,
  type BackendSharedDeviceView,
} from "./accountClient";
import {
  clearSession,
  decodeAccountEmail,
  extractMagicToken,
  keychainSecureStore,
  loadSession,
  saveSession,
  type AccountSession,
  type SecureStore,
} from "./accountSession";
import {
  DEFAULT_ACCOUNT_BASE_URL,
  isValidAccountBaseUrl,
  loadAccountConfig,
  persistAccountConfig,
  type AccountConfig,
} from "./accountConfig";

export interface AccountStateDeps {
  store?: SecureStore;
  createClient?: (baseUrl: string, getToken: () => string | null) => AccountClient;
}

export class AccountStateManager {
  session: AccountSession | null = null;
  devices: BackendDeviceView[] = [];
  sharedDevices: BackendSharedDeviceView[] = [];
  config: AccountConfig = { baseUrl: DEFAULT_ACCOUNT_BASE_URL };
  loading = true;
  error: string | null = null;
  client: AccountClient;

  private readonly store: SecureStore;
  private readonly createClient: (
    baseUrl: string,
    getToken: () => string | null,
  ) => AccountClient;
  private readonly listeners = new Set<() => void>();

  constructor(deps: AccountStateDeps = {}) {
    this.store = deps.store ?? keychainSecureStore;
    this.createClient =
      deps.createClient ?? ((baseUrl, getToken) => new AccountClient(baseUrl, getToken));
    this.client = this.createClient(this.config.baseUrl, () => this.session?.token ?? null);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  /** Loads persisted config + session; refreshes devices when signed in. */
  async init(): Promise<void> {
    this.config = await loadAccountConfig(this.store);
    this.client = this.createClient(this.config.baseUrl, () => this.session?.token ?? null);
    this.session = await loadSession(this.store);
    this.loading = false;
    this.emit();
    if (this.session) {
      await this.refreshDevices();
    }
  }

  async requestMagicLink(email: string): Promise<void> {
    await this.client.requestMagicLink(email);
  }

  /**
   * Completes sign-in from a magic-link URL, an https verify URL, or a raw
   * token pasted from the email. Persists the session, then pulls devices.
   */
  async completeLogin(rawInput: string): Promise<void> {
    const token = extractMagicToken(rawInput);
    if (!token) {
      throw new Error(
        "Couldn't find a sign-in token in that text. Paste the full link from your email.",
      );
    }
    const jwt = await this.client.consumeMagicLink(token);
    const email = decodeAccountEmail(jwt) ?? "";
    const session: AccountSession = { token: jwt, email };
    await saveSession(session, this.store);
    this.session = session;
    this.error = null;
    this.emit();
    await this.refreshDevices();
  }

  async logout(): Promise<void> {
    try {
      await this.client.logout();
    } catch {
      // Best effort — local state is the source of truth for sign-out.
    }
    await clearSession(this.store);
    this.session = null;
    this.devices = [];
    this.sharedDevices = [];
    this.emit();
  }

  /**
   * Permanently deletes the account on the server, then signs out locally.
   * Throws (leaving everything as it was) if the server doesn't confirm.
   */
  async deleteAccount(): Promise<void> {
    await this.client.deleteAccount();
    await clearSession(this.store);
    this.session = null;
    this.devices = [];
    this.sharedDevices = [];
    this.error = null;
    this.emit();
  }

  async refreshDevices(): Promise<void> {
    if (!this.session) {
      return;
    }
    try {
      const [devices, sharedDevices] = await Promise.all([
        this.client.listDevices(),
        this.client.listSharedDevices(),
      ]);
      this.devices = devices;
      this.sharedDevices = sharedDevices;
      this.error = null;
    } catch (err) {
      if (err instanceof AccountApiError && err.status === 401) {
        // Stale/revoked token — fail closed and sign out locally.
        await this.logout();
        this.error = "Your sign-in expired. Please sign in again.";
      } else {
        this.error = err instanceof Error ? err.message : "Couldn't load your devices.";
      }
    }
    this.emit();
  }

  /** Points the client at a self-hosted backend (or back at the default). */
  async saveConfig(baseUrl: string): Promise<void> {
    if (!isValidAccountBaseUrl(baseUrl)) {
      throw new Error("Enter a valid server URL, e.g. https://api.example.com");
    }
    const normalized = baseUrl.trim().replace(/\/+$/, "");
    await persistAccountConfig({ baseUrl: normalized }, this.store);
    this.config = { baseUrl: normalized };
    this.client = this.createClient(normalized, () => this.session?.token ?? null);
    this.emit();
  }
}
