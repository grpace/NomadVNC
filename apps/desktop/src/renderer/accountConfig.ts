/**
 * Nomad account server address. Persisted locally so a self-hosted backend
 * can be used without rebuilding (Account → Advanced Server Settings).
 * Default is the public endpoint run by the maintainer (best-effort; see
 * docs/self-hosting.md); local dev uses http://localhost:3200
 * (backend/compose.yaml).
 */

export interface AccountConfig {
  baseUrl: string;
}

export const DEFAULT_ACCOUNT_BASE_URL = "https://api.nomadvnc.dev.greg.tech";

const STORAGE_KEY = "nomadvnc.desktop.accountConfig.v1";

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

export function loadAccountConfig(): AccountConfig {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
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

export function persistAccountConfig(config: AccountConfig): void {
  const baseUrl = sanitizeBaseUrl(config.baseUrl) ?? DEFAULT_ACCOUNT_BASE_URL;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ baseUrl }));
}

/** Used by the account panel to validate the server field before saving. */
export function isValidAccountBaseUrl(value: string): boolean {
  return sanitizeBaseUrl(value) !== null;
}
