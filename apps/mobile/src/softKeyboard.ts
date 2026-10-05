/**
 * Soft-keyboard typing for the mobile viewer.
 *
 * The phone keyboard types into a hidden text field; every change is
 * diffed against the previous contents and replayed into the remote
 * session as Backspaces plus typed text. The remote cursor is always "at
 * the end", so the diff only looks for the common prefix: autocorrect,
 * "double-space for a full stop", and suggestion taps all become
 * backspace-then-retype, exactly what the remote needs.
 *
 * The field always starts with a run of spaces (the sentinel) so that
 * Backspace on an otherwise empty field still produces a change.
 */

export const KEYBOARD_SENTINEL = " ".repeat(16);

/** Past this length the field is reset at the next word boundary. */
const RESET_LENGTH = 64;

export interface SoftKeyboardEdit {
  /** Backspaces to send first (counted in characters, not UTF-16 units). */
  backspaces: number;
  /** Text to type after the backspaces. */
  text: string;
  /** The field's next contents (reset to the sentinel when appropriate). */
  next: string;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export function diffSoftKeyboardText(previous: string, current: string): SoftKeyboardEdit {
  const max = Math.min(previous.length, current.length);
  let common = 0;
  while (common < max && previous[common] === current[common]) common += 1;
  // Never split a surrogate pair (emoji): back up to its start.
  if (common > 0 && isHighSurrogate(previous.charCodeAt(common - 1))) common -= 1;
  const removed = previous.slice(common);
  const text = current.slice(common);
  const backspaces = Array.from(removed).length;
  const intoSentinel = !current.startsWith(KEYBOARD_SENTINEL);
  const atBoundary = text.endsWith("\n") || (current.length > RESET_LENGTH && /\s$/.test(text));
  return {
    backspaces,
    text,
    next: intoSentinel || atBoundary ? KEYBOARD_SENTINEL : current,
  };
}
