/**
 * Nomad account session helpers for mobile. The JWT lives in the OS secure
 * enclave (iOS Keychain / Android Keystore via react-native-keychain) —
 * parity with desktop, which keeps it in the OS keyring. Only the decoded
 * display email is kept in memory. Nothing here verifies the signature — the
 * backend is the authority; a stale token simply fails closed (401) and the
 * UI signs out.
 *
 * `extractMagicToken` / `decodeAccountEmail` are ports of the desktop
 * `accountSession.ts` helpers. The base64 decode is implemented by hand
 * because Hermes has no `atob`.
 */

import * as Keychain from "react-native-keychain";

export interface AccountSession {
  token: string;
  email: string;
}

/** Minimal async key/value store so tests can inject an in-memory fake. */
export interface SecureStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
}

const SESSION_KEY = "nomadvnc.account.session.v1";

/** Production store backed by the OS Keychain / Keystore. */
export const keychainSecureStore: SecureStore = {
  async get(key: string): Promise<string | null> {
    try {
      const creds = await Keychain.getGenericPassword({ service: key });
      if (!creds) {
        return null;
      }
      return creds.password;
    } catch {
      return null;
    }
  },
  async set(key: string, value: string): Promise<void> {
    await Keychain.setGenericPassword("nomadvnc", value, { service: key });
  },
  async del(key: string): Promise<void> {
    try {
      await Keychain.resetGenericPassword({ service: key });
    } catch {
      // Already gone — fine.
    }
  },
};

export async function loadSession(store: SecureStore = keychainSecureStore): Promise<AccountSession | null> {
  try {
    const raw = await store.get(SESSION_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as Partial<AccountSession>;
    if (typeof parsed.token !== "string" || parsed.token === "") {
      return null;
    }
    const email = decodeAccountEmail(parsed.token) ?? (typeof parsed.email === "string" ? parsed.email : "");
    return { token: parsed.token, email };
  } catch {
    return null;
  }
}

export async function saveSession(
  session: AccountSession,
  store: SecureStore = keychainSecureStore,
): Promise<void> {
  await store.set(SESSION_KEY, JSON.stringify(session));
}

export async function clearSession(store: SecureStore = keychainSecureStore): Promise<void> {
  await store.del(SESSION_KEY);
}

/**
 * One redemption at a time for each token. Overlapping deliveries (the OS
 * event and a later read of the same link) share that attempt. After it
 * finishes, a later call can try again, so a failed request is not stuck.
 */
export function createMagicLinkGate(): {
  run(token: string, task: () => Promise<void>): Promise<void>;
} {
  const inflight = new Map<string, Promise<void>>();
  return {
    run(token, task) {
      const existing = inflight.get(token);
      if (existing) {
        return existing;
      }
      const job = task().finally(() => {
        if (inflight.get(token) === job) {
          inflight.delete(token);
        }
      });
      inflight.set(token, job);
      return job;
    },
  };
}

const RAW_MAGIC_TOKEN = /^[A-Za-z0-9_-]{16,256}$/;

/**
 * Token from a `nomadvnc://auth/callback` link, or null for any other URL.
 * The app registers that scheme; other links (Tailscale, https) must not
 * start a sign-in. Matched as text: React Native's URL class throws on
 * `protocol` and `searchParams.get`, so `new URL` cannot read this link.
 */
export function magicLinkFromUrl(input: string): string | null {
  const trimmed = input.trim();
  const callback =
    /^nomadvnc:\/\/auth\/callback\/?(?:[?#]|$)/i.test(trimmed) ||
    /^nomadvnc:\/\/\/auth\/callback\/?(?:[?#]|$)/i.test(trimmed);
  if (!callback) {
    return null;
  }
  return extractMagicToken(trimmed);
}

/** One mail line-wrap, not a blank line between the link and the next sentence. */
function skipOneLineWrap(text: string, index: number): number | null {
  let i = index;
  if (text[i] === "\r") {
    i += 1;
  }
  if (text[i] !== "\n") {
    return null;
  }
  i += 1;
  if (text[i] === "\r") {
    i += 1;
  }
  if (text[i] === "\n") {
    return null;
  }
  while (text[i] === " " || text[i] === "\t") {
    i += 1;
  }
  return i;
}

function readTokenAt(text: string, start: number): string | null {
  let i = start;
  let token = "";
  while (i < text.length && token.length < 256) {
    const ch = text[i] ?? "";
    if (/[A-Za-z0-9_-]/.test(ch)) {
      token += ch;
      i += 1;
      continue;
    }
    const wrapped = skipOneLineWrap(text, i);
    const next = wrapped == null ? "" : (text[wrapped] ?? "");
    if (wrapped != null && /[A-Za-z0-9_-]/.test(next)) {
      i = wrapped;
      continue;
    }
    break;
  }
  return token === "" ? null : token;
}

function tokenAfterMarker(text: string): string | null {
  const markers = /(?:^|[?&#])token=/g;
  for (const match of text.matchAll(markers)) {
    const token = readTokenAt(text, match.index + match[0].length);
    if (token) {
      return token;
    }
  }
  return null;
}

/**
 * Accepts the magic-link URL from the email
 * (`nomadvnc://auth/callback?token=...`), an https verify URL, the same
 * link wrapped in the rest of the message, or the raw token itself.
 */
export function extractMagicToken(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") {
    return null;
  }
  const direct = tokenAfterMarker(trimmed);
  if (direct) {
    return direct;
  }
  try {
    const decoded = tokenAfterMarker(decodeURIComponent(trimmed));
    if (decoded) {
      return decoded;
    }
  } catch {
    // A stray % is not an encoded link.
  }
  // Raw opaque tokens are base64url without spaces or slashes.
  return RAW_MAGIC_TOKEN.test(trimmed) ? trimmed : null;
}

/** Reads the display email from the JWT payload without verifying it. */
export function decodeAccountEmail(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return null;
    }
    const json = utf8Decode(base64UrlToBytes(parts[1] as string));
    const payload = JSON.parse(json) as { email?: unknown };
    return typeof payload.email === "string" && payload.email !== "" ? payload.email : null;
  } catch {
    return null;
  }
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64UrlToBytes(input: string): number[] {
  let b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  b64 += "=".repeat((4 - (b64.length % 4)) % 4);
  const bytes: number[] = [];
  let bits = 0;
  let bitCount = 0;
  for (const ch of b64) {
    if (ch === "=") {
      break;
    }
    const val = B64_ALPHABET.indexOf(ch);
    if (val < 0) {
      throw new Error("invalid base64");
    }
    bits = (bits << 6) | val;
    bitCount += 6;
    if (bitCount >= 8) {
      bitCount -= 8;
      bytes.push((bits >> bitCount) & 0xff);
    }
  }
  return bytes;
}

function utf8Decode(bytes: number[]): string {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i] as number;
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
      i += 1;
    } else if ((b0 & 0xe0) === 0xc0) {
      out += String.fromCharCode(((b0 & 0x1f) << 6) | ((bytes[i + 1] as number) & 0x3f));
      i += 2;
    } else if ((b0 & 0xf0) === 0xe0) {
      out += String.fromCharCode(
        ((b0 & 0x0f) << 12) | (((bytes[i + 1] as number) & 0x3f) << 6) | ((bytes[i + 2] as number) & 0x3f),
      );
      i += 3;
    } else {
      const cp =
        ((b0 & 0x07) << 18) |
        (((bytes[i + 1] as number) & 0x3f) << 12) |
        (((bytes[i + 2] as number) & 0x3f) << 6) |
        ((bytes[i + 3] as number) & 0x3f);
      const c = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
      i += 4;
    }
  }
  return out;
}
