/**
 * Keyboard-grab ("capture keys") helpers built on the Chromium Keyboard Lock
 * API (`navigator.keyboard.lock()`).
 *
 * When grabbed, Super / Alt-Tab / function keys go to the remote session
 * instead of being swallowed by the Linux host compositor (GNOME/KDE).
 * Esc is browser-reserved and always exits the grab; the toolbar Capture
 * toggle is the explicit off-switch. Everything here is best-effort and
 * never throws, so unsupported environments (plain browsers, jsdom) simply
 * report `false`.
 */

interface KeyboardLockApi {
  lock(keyCodes?: string[]): Promise<void>;
  unlock(): void;
}

function keyboardApi(): KeyboardLockApi | undefined {
  if (typeof navigator === "undefined") {
    return undefined;
  }
  const candidate = (navigator as Navigator & { keyboard?: KeyboardLockApi }).keyboard;
  return typeof candidate?.lock === "function" ? candidate : undefined;
}

export function isKeyboardGrabSupported(): boolean {
  return keyboardApi() !== undefined;
}

export async function requestKeyboardGrab(): Promise<boolean> {
  const api = keyboardApi();
  if (!api) {
    return false;
  }
  try {
    await api.lock();
    return true;
  } catch {
    return false;
  }
}

export function releaseKeyboardGrab(): void {
  try {
    keyboardApi()?.unlock();
  } catch {
    // Releasing a grab that was never taken is a no-op.
  }
}
