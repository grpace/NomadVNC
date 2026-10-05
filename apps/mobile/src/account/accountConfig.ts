/**
 * Nomad account server address for mobile. Persisted in the OS secure
 * enclave (same Keychain/Keystore store as the session) so a self-hosted
 * backend can be used without rebuilding (set on the sign-in screen).
 * Default is the public endpoint run by the maintainer (best-effort; see
 * docs/self-hosting.md).
 *
 * Async because the Keychain/Keystore is async — unlike desktop's
 * localStorage-backed config.
 */

import { keychainSecureStore, type SecureStore } from "./accountSession";

export interface AccountConfig {
  baseUrl: string;
}

export const DEFAULT_ACCOUNT_BASE_URL = "https://api.nomadvnc.dev.greg.tech";

const CONFIG_KEY = "nomadvnc.account.config.v1";

function sanitizeBaseUrl(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^/\s]+(:\d+)?$/.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export async function loadAccountConfig(
  store: SecureStore = keychainSecureStore,
): Promise<AccountConfig> {
  try {
    const raw = await store.get(CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AccountConfig>;
      const baseUrl = sanitizeBaseUrl(parsed.baseUrl);
      if (baseUrl) {
        return { baseUrl };
      }
    }
  } catch {
    // Corrupt storage falls back to defaults.
  }
  return { baseUrl: DEFAULT_ACCOUNT_BASE_URL };
}

export async function persistAccountConfig(
  config: AccountConfig,
  store: SecureStore = keychainSecureStore,
): Promise<void> {
  const baseUrl = sanitizeBaseUrl(config.baseUrl) ?? DEFAULT_ACCOUNT_BASE_URL;
  await store.set(CONFIG_KEY, JSON.stringify({ baseUrl }));
}

/** Used by the account UI to validate the server field before saving. */
export function isValidAccountBaseUrl(value: string): boolean {
  return sanitizeBaseUrl(value) !== null;
}
