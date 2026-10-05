import type { TailnetState } from "@nomadvnc/domain";

/** How often HomeScreen re-reads tailnet state while a browser sign-in is pending. */
export const SIGN_IN_POLL_MS = 3_000;

/**
 * The Tailscale sign-in URL to hand to the system browser, or null.
 * Only http(s) URLs are ever opened — the URL comes from the engine, but
 * `Linking.openURL` would happily launch any installed app's scheme.
 */
export function signInUrlFor(state: Pick<TailnetState, "loggedIn" | "authUrl"> | null | undefined): string | null {
  if (!state || state.loggedIn || !state.authUrl) {
    return null;
  }
  return isWebUrl(state.authUrl) ? state.authUrl : null;
}

export function isWebUrl(raw: string): boolean {
  return /^https?:\/\/[^\s]+$/i.test(raw.trim());
}
