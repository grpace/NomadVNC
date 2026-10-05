/**
 * Nomad account session helpers. The JWT lives in OS secure storage (main
 * process keyring via the `nomadNative` bridge); only the decoded display
 * email is kept in memory. Nothing here verifies the signature — the
 * backend is the authority; a stale token simply fails closed (401) and
 * the UI signs out.
 */

export interface AccountSession {
  token: string;
  email: string;
}

/**
 * Accepts the magic-link URL from the email
 * (`nomadvnc://auth/callback?token=...`), a legacy https verify URL, or the
 * raw token itself.
 */
export function extractMagicToken(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") {
    return null;
  }
  try {
    // Absolute URLs (and path-relative ones against a dummy base).
    const url = new URL(trimmed, "http://localhost");
    const fromQuery = url.searchParams.get("token");
    if (fromQuery && fromQuery.trim() !== "") {
      return fromQuery.trim();
    }
    // Hash-fragment variant, kept for forward compatibility.
    const fragment = url.hash.match(/token=([^&]+)/);
    if (fragment?.[1]) {
      return decodeURIComponent(fragment[1]);
    }
  } catch {
    // Not a URL — fall through to raw-token handling.
  }
  // Raw opaque tokens are base64url without spaces or slashes.
  if (/^[A-Za-z0-9_-]{16,}$/.test(trimmed)) {
    return trimmed;
  }
  return null;
}

/** Reads the display email from the JWT payload without verifying it. */
export function decodeAccountEmail(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }
    // base64url -> base64 for atob (renderer has no node Buffer).
    const base64 = (parts[1] as string).replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const json = decodeURIComponent(
      Array.from(atob(padded), (ch) => `%${ch.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""),
    );
    const payload = JSON.parse(json) as { email?: unknown };
    return typeof payload.email === "string" && payload.email !== "" ? payload.email : null;
  } catch {
    return null;
  }
}
