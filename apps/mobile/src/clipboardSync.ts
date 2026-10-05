/**
 * Clipboard sync helpers shared by the mobile viewer (desktop parity).
 *
 * Sync is bidirectional:
 * - remote → local: the viewer emits `viewerClipboard`; the host writes it to
 *   the device clipboard and records it via `markClipboardWritten` so the
 *   poll below doesn't echo it straight back into the remote session.
 * - local → remote: the host polls the device clipboard; anything that isn't
 *   empty and wasn't just written by us is pasted into the remote session
 *   via the viewer's `clipboardPaste` command.
 */

/**
 * Decide whether freshly-polled device clipboard text should be pasted into
 * the remote session. Returns the text to paste, or null when there's nothing
 * new (empty, or identical to what we last saw/wrote).
 */
export function clipboardTextToPaste(
  lastSeen: string,
  current: string | null | undefined,
): string | null {
  if (!current || current === lastSeen) return null;
  return current;
}

/**
 * How local→remote sync starts once the clipboard changes:
 * - "auto": read and send it (Android shows its own one-line notice).
 * - "offer": show a "Send clipboard" button — iOS prompts on every
 *   programmatic read, so reading must follow a tap.
 */
export type ClipboardPolicy = "auto" | "offer";

export function clipboardPolicyFor(os: string): ClipboardPolicy {
  return os === "ios" ? "offer" : "auto";
}

/** "Paste as typing" stops here: typing is slow and a huge paste is almost always a mistake. */
export const PASTE_AS_TYPING_LIMIT = 5000;
