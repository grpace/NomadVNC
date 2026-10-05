import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  type AppStateStatus,
  BackHandler,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  Vibration,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { NomadNativeModule } from "../native/NomadNativeModule";
import { buildMobileViewerHtml } from "../viewerHtml";
import {
  CONNECT_WATCHDOG_MS,
  MAX_RECONNECT_ATTEMPTS,
  isCredentialProblem,
  parseViewerEvent,
  reconnectDelayForAttempt,
  RESUME_PROBE_MS,
  resumeActionForState,
} from "../viewerConnection";
import { sendViewerCommand, ViewerKeysBar, XK } from "../components/ViewerKeysBar";
import { GestureGuide, POINTER_MODE_HINTS, POINTER_MODE_LABELS } from "../components/GestureGuide";
import { SessionToolbar, ToolbarChevron } from "../components/SessionToolbar";
import { clipboardPolicyFor, clipboardTextToPaste, PASTE_AS_TYPING_LIMIT } from "../clipboardSync";
import { diffSoftKeyboardText, KEYBOARD_SENTINEL } from "../softKeyboard";
import {
  effectiveViewPrefs,
  loadDeviceViewPrefs,
  loadMobileSettings,
  QUALITY_OPTIONS,
  saveDeviceViewPrefs,
  updateMobileSettings,
  type DeviceViewPrefs,
  type MobileSettings,
} from "../settings";
import {
  DISPLAY_REGIONS,
  regionLabel,
} from "../displayRegion";
import {
  IDLE_BOOST_QUALITY,
  qualityLabelFor,
  suggestAutoQuality,
} from "../autoQuality";
import type { PeerPathInfo } from "@nomadvnc/platform-contracts";
import type { PointerMode } from "@nomadvnc/viewer-shell";
import {
  cardElevation,
  darkTheme as homeDarkTheme,
  lightTheme as homeLightTheme,
  type MobileSession,
  type Theme,
} from "./HomeScreen";

interface ViewerScreenProps {
  session: MobileSession;
  /** macOS Screen Sharing (ARD) often needs the Mac account short name. */
  username?: string;
  onClose: () => void;
}

/**
 * Connection lifecycle, driven by genuine viewer events (not timers):
 * loading → connecting → connected ⇄ reconnecting → failed | authFailed
 */
type ConnState =
  | { kind: "loading" }
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "reconnecting"; attempt: number }
  | { kind: "failed"; reason: string }
  | { kind: "authFailed" };

/**
 * Bridges the shared viewer bootstrap's `window.parent.postMessage(...)`
 * events into React Native's `onMessage`. Runs before any page script
 * (including the deferred bootstrap module), so no viewer event is missed.
 * The native bridge (`window.ReactNativeWebView`) is provided by
 * react-native-webview itself.
 */
const POST_MESSAGE_SHIM = `
(function() {
  if (window.__nomadShimInstalled) return;
  window.__nomadShimInstalled = true;
  window.postMessage = function(msg) {
    var data = typeof msg === "string" ? msg : JSON.stringify(msg);
    try {
      if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
        window.ReactNativeWebView.postMessage(data);
      }
    } catch (e) {}
  };
})();
true;
`;

export function ViewerScreen({ session, username, onClose }: ViewerScreenProps) {
  const colorScheme = useColorScheme();
  const isDark = colorScheme !== "light";
  const theme = isDark ? darkTheme : lightTheme;
  const styles = makeStyles(theme);

  const [connState, setConnState] = useState<ConnState>({ kind: "loading" });
  const [loadError, setLoadError] = useState<string | null>(null);
  // Increment to force WebView remount on (re)connect attempts
  const [webviewKey, setWebviewKey] = useState(0);
  // Password can be re-entered after an auth failure
  const [password, setPassword] = useState(session.password);
  const [authPassword, setAuthPassword] = useState("");
  // Keyboard panel (extra-keys bar + the phone keyboard) and viewer prefs
  const webViewRef = useRef<WebView | null>(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [softKeyboardVisible, setSoftKeyboardVisible] = useState(false);
  const keyboardInputRef = useRef<TextInput | null>(null);
  const keyboardBufferRef = useRef(KEYBOARD_SENTINEL);
  const [keyboardText, setKeyboardText] = useState(KEYBOARD_SENTINEL);
  const [showDisplay, setShowDisplay] = useState(false);
  // Touch input mode, pinch-zoom level, gestures help
  const [pointerMode, setPointerMode] = useState<PointerMode>("touch");
  const pointerModeRef = useRef<PointerMode>("touch");
  const [zoomLevel, setZoomLevel] = useState(1);
  const [showGestures, setShowGestures] = useState(false);
  const [showTip, setShowTip] = useState(false);
  // The session bar hides so a portrait phone can use the height. It comes
  // back from the pill, and always returns if the session isn't live.
  const [chromeHidden, setChromeHidden] = useState(false);
  const [sticky, setSticky] = useState<Record<number, boolean>>({});
  const [settings, setSettings] = useState<MobileSettings | null>(null);
  const [devicePrefs, setDevicePrefs] = useState<DeviceViewPrefs>({});
  const settingsRef = useRef<MobileSettings | null>(null);
  const devicePrefsRef = useRef<DeviceViewPrefs>({});
  // Tailnet path health for auto-quality (desktop parity). `undefined`
  // while the first sample loads, `null` when diagnostics are unavailable.
  const [connectionPath, setConnectionPath] = useState<PeerPathInfo | null | undefined>(undefined);
  const connectionPathRef = useRef<PeerPathInfo | null | undefined>(undefined);
  const autoQualityRef = useRef(false);
  const effectiveQualityRef = useRef(8);
  const idleBoostedRef = useRef(false);
  // Clipboard sync (desktop parity): remote→local on viewerClipboard events;
  // local→remote when the device clipboard changes (see the effect below).
  // Default from Settings, toggleable in the Display panel.
  const [syncClipboard, setSyncClipboard] = useState(true);
  const syncClipboardRef = useRef(true);
  const lastLocalClipboard = useRef("");
  const lastClipboardToken = useRef<string | null>(null);
  // iOS asks before an app reads the clipboard, so there we offer a
  // "Send clipboard" button instead of reading it automatically.
  const [clipboardOffer, setClipboardOffer] = useState(false);

  useEffect(() => {
    syncClipboardRef.current = syncClipboard;
  }, [syncClipboard]);

  useEffect(() => {
    connectionPathRef.current = connectionPath;
  }, [connectionPath]);

  useEffect(() => {
    void loadMobileSettings().then((s) => {
      settingsRef.current = s;
      setSettings(s);
      setSyncClipboard(s.clipboardSync);
      pointerModeRef.current = s.pointerMode;
      setPointerMode(s.pointerMode);
    });
    if (session.deviceId) {
      const id = session.deviceId;
      void loadDeviceViewPrefs(id).then((p) => {
        devicePrefsRef.current = p;
        setDevicePrefs(p);
      });
    }
    // session.deviceId is stable for the screen's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Tailnet path health for auto-quality (desktop parity): sample on mount,
  // then refresh every 15s. Advisory only — a failed sample just means the
  // manual quality setting stands.
  useEffect(() => {
    if (!session.host) {
      setConnectionPath(null);
      return;
    }
    const host = session.host;
    let cancelled = false;
    async function refreshPath(): Promise<void> {
      try {
        const info = await NomadNativeModule.getPeerPath(host);
        if (!cancelled) setConnectionPath(info);
      } catch {
        if (!cancelled) setConnectionPath(null);
      }
    }
    setConnectionPath(undefined);
    void refreshPath();
    const timer = setInterval(() => {
      void refreshPath();
    }, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // session.host is stable for the screen's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Effective quality: auto degrades the manual ceiling on slow links.
  const manualQuality = settings
    ? effectiveViewPrefs(settings, devicePrefs).quality
    : 8;
  const autoQualityOn = settings?.autoQuality ?? false;
  const effectiveQuality = autoQualityOn
    ? (suggestAutoQuality(connectionPath, manualQuality) ?? manualQuality)
    : manualQuality;

  useEffect(() => {
    autoQualityRef.current = autoQualityOn;
  }, [autoQualityOn]);
  useEffect(() => {
    effectiveQualityRef.current = effectiveQuality;
  }, [effectiveQuality]);

  // Apply the effective quality whenever it changes (idle boosts bypass this).
  useEffect(() => {
    if (connState.kind !== "connected" || idleBoostedRef.current) return;
    sendViewerCommand(webViewRef, { type: "setQuality", quality: effectiveQuality });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveQuality, connState.kind]);

  const html = useMemo(
    () =>
      buildMobileViewerHtml({
        wsUrl: session.wsUrl,
        password,
        username,
        assetBaseUrl: session.assetBaseUrl,
        pointerMode: pointerModeRef.current,
      }),
    [session.wsUrl, session.assetBaseUrl, password, username],
  );

  // Track if we're still mounted to avoid state updates after unmount
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const attemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True once the user intentionally disconnects — suppresses reconnect.
  const intentionalCloseRef = useRef(false);
  // True while the auth-failed screen is showing. A `disconnected` viewer
  // event that races in after `credentialsRequired` must NOT trigger the
  // auto-reconnect loop (it would retry with the same bad password).
  const authFailedRef = useRef(false);
  // Whether this session ever completed a handshake. A failure before that
  // is "couldn't connect" (server down, wrong port): reported at once,
  // because retrying the same address won't help (desktop parity).
  const everConnectedRef = useRef(false);
  // Breaks the startWatchdog ⇄ scheduleReconnect dependency cycle.
  const scheduleReconnectRef = useRef<() => void>(() => {});

  const clearTimers = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (watchdogTimerRef.current) {
      clearTimeout(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  const startWatchdog = useCallback(() => {
    if (watchdogTimerRef.current) clearTimeout(watchdogTimerRef.current);
    watchdogTimerRef.current = setTimeout(() => {
      if (!mountedRef.current || intentionalCloseRef.current) return;
      // Viewer went silent — treat as a dead attempt.
      scheduleReconnectRef.current();
    }, CONNECT_WATCHDOG_MS);
  }, []);

  const remountViewer = useCallback(() => {
    if (!mountedRef.current) return;
    clearTimers();
    authFailedRef.current = false;
    setLoadError(null);
    setConnState({ kind: "connecting" });
    setWebviewKey((k) => k + 1);
    startWatchdog();
  }, [clearTimers, startWatchdog]);

  const scheduleReconnect = useCallback(() => {
    if (!mountedRef.current || intentionalCloseRef.current) return;
    // A disconnect and a failed resume probe can arrive together. One
    // wait is enough; stacking them burns the retry budget.
    if (reconnectTimerRef.current) return;
    // Auth failure is terminal for the auto-retry loop — the user must
    // re-enter the password. A `disconnected` racing in after
    // `credentialsRequired` must not restart the loop with bad creds.
    if (authFailedRef.current) return;
    clearTimers();
    const attempt = attemptRef.current;
    const delay = reconnectDelayForAttempt(attempt);
    if (delay === null) {
      setConnState({
        kind: "failed",
        reason: "Connection lost. Automatic retry exhausted",
      });
      return;
    }
    setConnState({ kind: "reconnecting", attempt: attempt + 1 });
    attemptRef.current = attempt + 1;
    reconnectTimerRef.current = setTimeout(() => {
      remountViewer();
    }, delay);
  }, [clearTimers, remountViewer]);

  // Keep the watchdog's reconnect hook current.
  scheduleReconnectRef.current = scheduleReconnect;

  const resetAndConnect = useCallback(() => {
    attemptRef.current = 0;
    remountViewer();
  }, [remountViewer]);

  const handleViewerMessage = useCallback(
    (event: WebViewMessageEvent) => {
      if (!mountedRef.current || intentionalCloseRef.current) return;
      const parsed = parseViewerEvent(event.nativeEvent.data);
      if (!parsed) return;
      if (parsed.type === "viewerState") {
        if (parsed.state === "connected") {
          clearTimers();
          attemptRef.current = 0;
          authFailedRef.current = false;
          everConnectedRef.current = true;
          idleBoostedRef.current = false;
          setConnState({ kind: "connected" });
          setZoomLevel(1);
          // Apply saved quality/scale prefs once the viewer is live.
          applyViewerPrefs();
          if (settingsRef.current && !settingsRef.current.gestureTipSeen) {
            setShowTip(true);
          }
        } else if (parsed.state === "disconnected" && !everConnectedRef.current && !authFailedRef.current) {
          clearTimers();
          setConnState({
            kind: "failed",
            reason: `Nothing answered${session.host ? ` at ${session.host}` : ""}. Check that the VNC server is running and the port is right.`,
          });
        } else if (parsed.state === "disconnected") {
          idleBoostedRef.current = false;
          // Ignored while the auth screen is up (see scheduleReconnect).
          scheduleReconnect();
        } else if (isCredentialProblem(parsed.state)) {
          clearTimers();
          authFailedRef.current = true;
          setAuthPassword("");
          setConnState({ kind: "authFailed" });
        }
      } else if (parsed.type === "viewerIdle") {
        // TurboVNC lesson: once input stops, the image is static — boost to
        // lossless so it sharpens up (desktop parity).
        if (
          autoQualityRef.current &&
          !idleBoostedRef.current &&
          effectiveQualityRef.current < IDLE_BOOST_QUALITY
        ) {
          idleBoostedRef.current = true;
          sendViewerCommand(webViewRef, {
            type: "setQuality",
            quality: IDLE_BOOST_QUALITY,
          });
        }
      } else if (parsed.type === "viewerActive") {
        if (idleBoostedRef.current) {
          idleBoostedRef.current = false;
          sendViewerCommand(webViewRef, {
            type: "setQuality",
            quality: effectiveQualityRef.current,
          });
        }
      } else if (parsed.type === "viewerClipboard") {
        // Remote clipboard changed → mirror to the device clipboard
        // (desktop parity). Record the text and the clipboard's new change
        // token so the watcher below doesn't echo it back.
        if (syncClipboardRef.current) {
          const newText = parsed.text ?? "";
          lastLocalClipboard.current = newText;
          NomadNativeModule.writeClipboard(newText)
            .then(() => NomadNativeModule.getClipboardChangeToken())
            .then((token) => {
              lastClipboardToken.current = token;
            })
            .catch(() => {});
        }
      } else if (parsed.type === "viewerAlive") {
        if (parsed.live === true && connStateRef.current.kind === "connected") {
          // Still up after backgrounding. Cancel the resume probe and
          // leave zoom, prefs, and the gesture tip alone.
          clearTimers();
        } else if (parsed.live === false) {
          scheduleReconnect();
        }
      } else if (parsed.type === "viewerZoom") {
        setZoomLevel(typeof parsed.level === "number" ? parsed.level : 1);
      } else if (parsed.type === "viewerLongPress") {
        // A short tick confirms the right click (iOS can only buzz long).
        if (Platform.OS === "android") Vibration.vibrate(12);
      }
    },
    [clearTimers, scheduleReconnect, session.host],
  );

  // Track the latest connection state for the AppState handler.
  const connStateRef = useRef<ConnState>({ kind: "loading" });
  useEffect(() => {
    connStateRef.current = connState;
  }, [connState]);

  // Background/foreground. Timers are frozen while the process is
  // suspended so a healthy session is not declared dead. On return, a
  // live socket is kept (and refreshed if the user actually left the
  // app). A socket the OS dropped reconnects in place. The local VNC
  // proxy stays up either way; leaving the app does not disconnect.
  const awayFromAppRef = useRef(false);
  const leftAppRef = useRef(false);
  const remountViewerRef = useRef(remountViewer);
  remountViewerRef.current = remountViewer;
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next: AppStateStatus) => {
      if (!mountedRef.current || intentionalCloseRef.current) return;
      if (next === "inactive" || next === "background") {
        awayFromAppRef.current = true;
        if (next === "background") leftAppRef.current = true;
        clearTimers();
        return;
      }
      if (next !== "active" || !awayFromAppRef.current) return;
      awayFromAppRef.current = false;
      const refresh = leftAppRef.current;
      leftAppRef.current = false;
      const action = resumeActionForState(connStateRef.current.kind);
      if (action === "probe") {
        sendViewerCommand(webViewRef, { type: "queryConnection", refresh });
        if (watchdogTimerRef.current) clearTimeout(watchdogTimerRef.current);
        watchdogTimerRef.current = setTimeout(() => {
          if (!mountedRef.current || intentionalCloseRef.current) return;
          scheduleReconnectRef.current();
        }, RESUME_PROBE_MS);
      } else if (action === "watch") {
        startWatchdog();
      } else if (action === "reconnect") {
        remountViewerRef.current();
      }
    });
    return () => sub.remove();
  }, [clearTimers, startWatchdog]);

  // Clipboard sync, local→remote (desktop parity). Polls only the
  // clipboard's change token — never its contents — so nothing is read
  // until something new is copied. Android then sends it automatically
  // (one system "pasted" notice per copy); iOS offers a button instead,
  // because reading there shows a permission prompt.
  useEffect(() => {
    if (!syncClipboard || connState.kind !== "connected") {
      setClipboardOffer(false);
      return;
    }
    const policy = clipboardPolicyFor(Platform.OS);
    let busy = false;
    const check = async (): Promise<void> => {
      if (busy || !mountedRef.current || intentionalCloseRef.current) return;
      busy = true;
      try {
        const token = await NomadNativeModule.getClipboardChangeToken();
        if (token === lastClipboardToken.current) return;
        lastClipboardToken.current = token;
        if (!token) {
          setClipboardOffer(false);
          return;
        }
        if (policy === "offer") {
          setClipboardOffer(true);
          return;
        }
        const text = await NomadNativeModule.readClipboard();
        const toPaste = clipboardTextToPaste(lastLocalClipboard.current, text);
        if (toPaste !== null) {
          lastLocalClipboard.current = toPaste;
          sendViewerCommand(webViewRef, { type: "clipboardPaste", text: toPaste });
        }
      } catch {
        // Clipboard unavailable (e.g. app not focused) — try again next tick.
      } finally {
        busy = false;
      }
    };
    void check();
    const interval = setInterval(() => void check(), 1500);
    return () => clearInterval(interval);
  }, [syncClipboard, connState.kind]);

  async function sendClipboardToRemote(): Promise<void> {
    setClipboardOffer(false);
    try {
      const text = await NomadNativeModule.readClipboard();
      if (text) {
        lastLocalClipboard.current = text;
        sendViewerCommand(webViewRef, { type: "clipboardPaste", text });
      }
    } catch {
      // Declined or unavailable.
    }
  }

  /** Types the device clipboard as key presses (works where paste doesn't, e.g. login screens). */
  async function pasteAsTyping(): Promise<void> {
    try {
      const text = await NomadNativeModule.readClipboard();
      if (text) {
        sendViewerCommand(webViewRef, {
          type: "typeText",
          text: text.slice(0, PASTE_AS_TYPING_LIMIT),
        });
      }
    } catch {
      // Declined or unavailable.
    }
  }

  // Keyboard panel: the extra-keys bar plus the phone keyboard, which types
  // into a hidden field (see softKeyboard.ts).
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", () => setSoftKeyboardVisible(true));
    const hide = Keyboard.addListener("keyboardDidHide", () => {
      setSoftKeyboardVisible(false);
      // Blur too, so the next focus() reopens the keyboard.
      keyboardInputRef.current?.blur();
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  function handleKeyboardText(value: string): void {
    const edit = diffSoftKeyboardText(keyboardBufferRef.current, value);
    if (edit.backspaces > 0) {
      sendViewerCommand(webViewRef, {
        type: "sendKeys",
        keysyms: Array.from({ length: edit.backspaces }, () => XK.BackSpace),
      });
    }
    if (edit.text) {
      sendViewerCommand(webViewRef, { type: "typeText", text: edit.text });
    }
    keyboardBufferRef.current = edit.next;
    setKeyboardText(edit.next);
  }

  function closeKeyboard(): void {
    keyboardInputRef.current?.blur();
    Keyboard.dismiss();
    setKeyboardOpen(false);
  }

  function toggleKeyboardPanel(): void {
    if (keyboardOpen) {
      closeKeyboard();
    } else {
      setShowDisplay(false);
      setKeyboardOpen(true);
      // Focus once the hidden field has mounted.
      setTimeout(() => keyboardInputRef.current?.focus(), 50);
    }
  }

  function toggleDisplay(): void {
    if (showDisplay) {
      setShowDisplay(false);
      return;
    }
    if (keyboardOpen) closeKeyboard();
    setShowDisplay(true);
  }

  function toggleSoftKeyboard(): void {
    if (softKeyboardVisible) {
      Keyboard.dismiss();
    } else {
      keyboardInputRef.current?.focus();
    }
  }

  function changePointerMode(mode: PointerMode): void {
    pointerModeRef.current = mode;
    setPointerMode(mode);
    sendViewerCommand(webViewRef, { type: "setPointerMode", mode });
    void updateMobileSettings({ pointerMode: mode }).then((next) => {
      settingsRef.current = { ...(settingsRef.current ?? next), pointerMode: mode };
    });
  }

  function hideChrome(): void {
    if (keyboardOpen) closeKeyboard();
    setShowDisplay(false);
    setChromeHidden(true);
  }

  function dismissTip(): void {
    setShowTip(false);
    if (settingsRef.current) {
      settingsRef.current = { ...settingsRef.current, gestureTipSeen: true };
    }
    void updateMobileSettings({ gestureTipSeen: true });
  }

  // Stop the session when the viewer screen goes away (Disconnect, or
  // the user leaves the screen). Backgrounding does not unmount this
  // screen and must not stop the session.
  const sessionIdRef = useRef(session.sessionId);
  useEffect(() => {
    return () => {
      // Best-effort cleanup on unmount
      NomadNativeModule.stopVncSession(sessionIdRef.current).catch(() => {
        // Ignore — session may already be stopped
      });
    };
  }, []);

  const handleClose = useCallback(async () => {
    intentionalCloseRef.current = true;
    clearTimers();
    try {
      await NomadNativeModule.stopVncSession(session.sessionId);
    } catch {
      // Ignore cleanup errors
    } finally {
      onClose();
    }
  }, [session.sessionId, onClose, clearTimers]);

  // Android hardware back: disconnect instead of popping to a broken state
  useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      void handleClose();
      return true; // Prevent default back behavior
    });
    return () => sub.remove();
  }, [handleClose]);

  function handlePageLoadEnd(): void {
    if (!mountedRef.current || intentionalCloseRef.current) return;
    // HTML loaded; now wait for the viewer to report its VNC state.
    setConnState((prev) => (prev.kind === "loading" ? { kind: "connecting" } : prev));
    startWatchdog();
  }

  function handlePageError(description: string): void {
    if (!mountedRef.current) return;
    clearTimers();
    setLoadError(description);
    setConnState({ kind: "failed", reason: description });
  }

  function toggleSticky(keysym: number): void {
    setSticky((prev) => {
      const nextDown = !prev[keysym];
      sendViewerCommand(webViewRef, {
        type: "setKeyStates",
        keys: [{ keysym, down: nextDown }],
      });
      return { ...prev, [keysym]: nextDown };
    });
  }

  function cycleQuality(): void {
    const prefs = settingsRef.current;
    if (!prefs) return;
    const order: number[] = QUALITY_OPTIONS.map((o) => o.value);
    const current = effectiveViewPrefs(prefs, devicePrefsRef.current).quality;
    const next = order[(order.indexOf(current) + 1) % order.length] ?? order[0]!;
    applyDevicePref({ quality: next });
  }

  function toggleScaleMode(): void {
    const prefs = settingsRef.current;
    if (!prefs) return;
    const current = effectiveViewPrefs(prefs, devicePrefsRef.current).scaleMode;
    applyDevicePref({ scaleMode: current === "fit" ? "actual" : "fit" });
  }

  function cycleDisplayRegion(): void {
    const prefs = settingsRef.current;
    if (!prefs) return;
    const current = effectiveViewPrefs(prefs, devicePrefsRef.current).displayRegion;
    const idx = DISPLAY_REGIONS.indexOf(current);
    const next = DISPLAY_REGIONS[(idx + 1) % DISPLAY_REGIONS.length] ?? "full";
    applyDevicePref({ displayRegion: next });
  }

  /** Applies a pref now; persists per-device when this is a saved device. */
  function applyDevicePref(partial: DeviceViewPrefs): void {
    const next = { ...devicePrefsRef.current, ...partial };
    devicePrefsRef.current = next;
    setDevicePrefs(next);
    const prefs = settingsRef.current;
    if (prefs) {
      const effective = effectiveViewPrefs(prefs, next);
      const quality = prefs.autoQuality
        ? (suggestAutoQuality(connectionPathRef.current, effective.quality) ?? effective.quality)
        : effective.quality;
      sendViewerCommand(webViewRef, { type: "setQuality", quality });
      sendViewerCommand(webViewRef, { type: "setScaleMode", mode: effective.scaleMode });
      sendViewerCommand(webViewRef, {
        type: "setDisplayRegion",
        region: effective.displayRegion,
      });
    }
    if (session.deviceId) {
      void saveDeviceViewPrefs(session.deviceId, next);
    }
  }

  function applyViewerPrefs(): void {
    sendViewerCommand(webViewRef, { type: "setPointerMode", mode: pointerModeRef.current });
    const prefs = settingsRef.current;
    if (!prefs) return;
    const effective = effectiveViewPrefs(prefs, devicePrefsRef.current);
    sendViewerCommand(webViewRef, {
      type: "setQuality",
      quality: effectiveQualityRef.current,
    });
    sendViewerCommand(webViewRef, {
      type: "setScaleMode",
      mode: effective.scaleMode,
    });
    sendViewerCommand(webViewRef, {
      type: "setDisplayRegion",
      region: effective.displayRegion,
    });
  }

  function handleAuthRetry(): void {
    if (!authPassword) return;
    clearTimers();
    attemptRef.current = 0;
    authFailedRef.current = false;
    setPassword(authPassword);
    // Regenerating the HTML with the new password remounts via key change
    setWebviewKey((k) => k + 1);
    setConnState({ kind: "connecting" });
    startWatchdog();
  }

  // The overlay (opaque, with a spinner) is only for "not live yet". Once
  // connected it must disappear — it used to read "Connected" and keep
  // covering the remote desktop.
  const statusLabel =
    connState.kind === "connected"
      ? null
      : connState.kind === "reconnecting"
        ? `Connection lost. Retrying (${connState.attempt}/${MAX_RECONNECT_ATTEMPTS})…`
        : connState.kind === "connecting" || connState.kind === "loading"
          ? "Connecting…"
          : null;

  const connected = connState.kind === "connected";
  const effective = settings ? effectiveViewPrefs(settings, devicePrefs) : null;
  const showChrome = !chromeHidden || !connected;

  return (
    <SafeAreaView style={styles.safe}>
      {showChrome && (
        <SessionToolbar
          theme={theme}
          title={session.label || session.host || "Live Session"}
          connected={connected}
          keyboardOpen={keyboardOpen}
          displayOpen={showDisplay}
          displayAttention={clipboardOffer}
          onToggleKeyboard={toggleKeyboardPanel}
          onToggleDisplay={toggleDisplay}
          onDisconnect={() => void handleClose()}
          onHide={hideChrome}
        />
      )}

      {/* "padding" on Android too: apps targeting Android 15 are drawn
          edge-to-edge, so the window no longer shrinks for the keyboard.
          The padding is the measured overlap, so it is 0 wherever the OS
          does resize. */}
      <KeyboardAvoidingView style={styles.body} behavior="padding">
        {connState.kind === "failed" ? (
          <View style={styles.center}>
            <Text style={styles.errorTitle}>Couldn't Connect</Text>
            <Text style={styles.errorDetail}>{connState.reason}</Text>
            <Pressable
              onPress={resetAndConnect}
              style={styles.retryButton}
              accessibilityRole="button"
              accessibilityLabel="Retry connection"
            >
              <Text style={styles.retryLabel}>Retry</Text>
            </Pressable>
          </View>
        ) : connState.kind === "authFailed" ? (
          <View style={styles.center}>
            <Text style={styles.errorTitle}>Authentication Failed</Text>
            <Text style={styles.errorDetail}>
              The server rejected the credentials. Check the password
              {username ? ` for “${username}”` : ""} and try again.
            </Text>
            <TextInput
              value={authPassword}
              onChangeText={setAuthPassword}
              placeholder="VNC password"
              placeholderTextColor={theme.muted}
              style={styles.input}
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="VNC password"
              accessibilityHint="Re-enter the VNC server password"
              returnKeyType="go"
              onSubmitEditing={handleAuthRetry}
            />
            <Pressable
              onPress={handleAuthRetry}
              style={styles.retryButton}
              accessibilityRole="button"
              accessibilityLabel="Retry with new password"
            >
              <Text style={styles.retryLabel}>Connect</Text>
            </Pressable>
          </View>
        ) : (
          <View style={styles.webviewWrap}>
            <WebView
              key={`viewer-${webviewKey}`}
              ref={webViewRef}
              originWhitelist={["*"]}
              source={{ html }}
              style={styles.webview}
              injectedJavaScriptBeforeContentLoaded={POST_MESSAGE_SHIM}
              onMessage={handleViewerMessage}
              onLoadEnd={handlePageLoadEnd}
              onError={(e) => {
                handlePageError(e.nativeEvent.description ?? "Unknown load error");
              }}
              onHttpError={(e) => {
                handlePageError(`HTTP ${e.nativeEvent.statusCode}`);
              }}
              onContentProcessDidTerminate={() => {
                if (!mountedRef.current || intentionalCloseRef.current || authFailedRef.current) return;
                remountViewerRef.current();
              }}
              onRenderProcessGone={() => {
                if (!mountedRef.current || intentionalCloseRef.current || authFailedRef.current) return;
                remountViewerRef.current();
              }}
              // The viewer handles every gesture itself (input.mjs):
              // no native pinch-zoom, scrolling, or overscroll bounce.
              scalesPageToFit={false}
              setBuiltInZoomControls={false}
              scrollEnabled={false}
              bounces={false}
              overScrollMode="never"
              allowsInlineMediaPlayback
              mediaPlaybackRequiresUserAction={false}
            />
            {connected && chromeHidden && (
              <View style={styles.restoreRow} pointerEvents="box-none">
                <Pressable
                  onPress={() => setChromeHidden(false)}
                  style={styles.restore}
                  accessibilityRole="button"
                  accessibilityLabel="Show toolbar"
                >
                  <ToolbarChevron color={theme.text} />
                  <Text style={styles.restoreLabel}>Toolbar</Text>
                </Pressable>
              </View>
            )}
            {connected && zoomLevel > 1.01 && (
              <View style={styles.floatingRow} pointerEvents="box-none">
                <Pressable
                  onPress={() => sendViewerCommand(webViewRef, { type: "resetView" })}
                  style={styles.floatingChip}
                  accessibilityRole="button"
                  accessibilityLabel="Reset zoom"
                >
                  <Text style={styles.floatingChipLabel}>{`${zoomLevel.toFixed(1)}× · Reset`}</Text>
                </Pressable>
              </View>
            )}
            {connected && showTip && (
              <View style={styles.tipCard}>
                <Text style={styles.tipTitle}>
                  {POINTER_MODE_LABELS[pointerMode]} Mode
                </Text>
                <Text style={styles.tipText}>
                  Two-finger tap right-clicks. Pinch to zoom.
                </Text>
                <View style={styles.tipActions}>
                  <Pressable
                    onPress={() => {
                      dismissTip();
                      setShowGestures(true);
                    }}
                    accessibilityRole="button"
                    hitSlop={8}
                  >
                    <Text style={styles.link}>All Gestures</Text>
                  </Pressable>
                  <Pressable onPress={dismissTip} accessibilityRole="button" hitSlop={8}>
                    <Text style={styles.link}>Got It</Text>
                  </Pressable>
                </View>
              </View>
            )}
            {showGestures && (
              <View style={styles.sheetBackdrop}>
                <View style={styles.sheet}>
                  <View style={styles.sheetHeader}>
                    <Text style={styles.sheetTitle}>
                      Gestures · {POINTER_MODE_LABELS[pointerMode]} Mode
                    </Text>
                    <Pressable
                      onPress={() => setShowGestures(false)}
                      accessibilityRole="button"
                      accessibilityLabel="Close gestures"
                      hitSlop={12}
                    >
                      <Text style={styles.link}>Done</Text>
                    </Pressable>
                  </View>
                  <ScrollView contentContainerStyle={styles.sheetBody}>
                    <Text style={styles.sheetHint}>{POINTER_MODE_HINTS[pointerMode]}</Text>
                    <GestureGuide theme={theme} mode={pointerMode} />
                    <Text style={styles.sheetHint}>
                      A mouse or trackpad connected to this {Platform.OS === "ios" ? "iPad or iPhone" : "device"} works
                      directly. The Keyboard bar has Ctrl, Alt, function keys, and Paste.
                    </Text>
                  </ScrollView>
                </View>
              </View>
            )}
            {statusLabel && (
              <View style={styles.loadingOverlay} pointerEvents="none">
                <ActivityIndicator
                  size="large"
                  color={theme.accent}
                  accessibilityLabel={statusLabel}
                />
                <Text style={styles.loadingText}>{statusLabel}</Text>
              </View>
            )}
            {loadError && (
              <View style={styles.loadingOverlay} pointerEvents="none">
                <Text style={styles.errorDetail}>{loadError}</Text>
              </View>
            )}
          </View>
        )}
        {showDisplay && connected && (
          <View style={styles.displayBar}>
            <Pressable
              onPress={() => changePointerMode(pointerMode === "touch" ? "trackpad" : "touch")}
              style={styles.displayRow}
              accessibilityRole="button"
              accessibilityLabel={`Pointer mode: ${POINTER_MODE_LABELS[pointerMode]}. Tap to switch.`}
            >
              <Text style={styles.displayLabel}>Pointer</Text>
              <Text style={styles.displayValue}>{POINTER_MODE_LABELS[pointerMode]}</Text>
            </Pressable>
            <Pressable
              onPress={toggleScaleMode}
              style={styles.displayRow}
              accessibilityRole="button"
              accessibilityLabel="Toggle scale mode"
            >
              <Text style={styles.displayLabel}>Scale</Text>
              <Text style={styles.displayValue}>
                {effective ? (effective.scaleMode === "fit" ? "Fit Screen" : "Actual Size") : "…"}
              </Text>
            </Pressable>
            <Pressable
              onPress={cycleDisplayRegion}
              style={styles.displayRow}
              accessibilityRole="button"
              accessibilityLabel="Cycle display region"
            >
              <Text style={styles.displayLabel}>Region</Text>
              <Text style={styles.displayValue}>
                {effective ? regionLabel(effective.displayRegion) : "…"}
              </Text>
            </Pressable>
            <Pressable
              onPress={cycleQuality}
              style={styles.displayRow}
              accessibilityRole="button"
              accessibilityLabel="Cycle quality"
            >
              <Text style={styles.displayLabel}>Quality</Text>
              <Text style={styles.displayValue}>
                {settings
                  ? `${qualityLabelFor(effectiveQuality)}${
                      autoQualityOn && effectiveQuality !== manualQuality ? " · Auto" : ""
                    }`
                  : "…"}
              </Text>
            </Pressable>
            <Pressable
              onPress={() => setSyncClipboard((v) => !v)}
              style={styles.displayRow}
              accessibilityRole="togglebutton"
              accessibilityState={{ selected: syncClipboard }}
              accessibilityLabel="Toggle clipboard sync"
            >
              <Text style={styles.displayLabel}>Clipboard</Text>
              <Text style={styles.displayValue}>{syncClipboard ? "On" : "Off"}</Text>
            </Pressable>
            {Platform.OS === "ios" && (
              <Pressable
                onPress={() => void sendClipboardToRemote()}
                style={styles.displayRow}
                accessibilityRole="button"
                accessibilityLabel="Send clipboard to the remote machine"
              >
                <Text style={styles.displayLabel}>Send Clipboard</Text>
                <Text style={styles.displayValue}>{clipboardOffer ? "New" : "Send"}</Text>
              </Pressable>
            )}
            <Pressable
              onPress={() => setShowGestures(true)}
              style={[styles.displayRow, styles.displayRowLast]}
              accessibilityRole="button"
              accessibilityLabel="Show touch gestures"
            >
              <Text style={styles.displayLabel}>Gestures</Text>
              <Text style={styles.displayValue}>›</Text>
            </Pressable>
          </View>
        )}
        {keyboardOpen && connected && (
          <>
            <ViewerKeysBar
              theme={theme}
              webViewRef={webViewRef}
              sticky={sticky}
              onToggleSticky={toggleSticky}
              softKeyboardVisible={softKeyboardVisible}
              onToggleSoftKeyboard={toggleSoftKeyboard}
              onPasteAsTyping={() => void pasteAsTyping()}
            />
            {/* The phone keyboard types into this invisible field; every
                edit is replayed into the remote session. */}
            <TextInput
              ref={keyboardInputRef}
              value={keyboardText}
              onChangeText={handleKeyboardText}
              style={styles.hiddenInput}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
              importantForAutofill="no"
              // Android: commit every key immediately (no word composition),
              // so typing reaches the remote machine as you type.
              keyboardType={Platform.OS === "android" ? "visible-password" : "default"}
              caretHidden
              contextMenuHidden
              accessibilityLabel="Type to the remote machine"
            />
          </>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const darkTheme: Theme = {
  ...homeDarkTheme,
};

const lightTheme: Theme = {
  ...homeLightTheme,
};

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    safe: {
      flex: 1,
      backgroundColor: theme.bg,
    },
    link: {
      color: theme.accent,
      fontWeight: "600",
      fontSize: 16,
    },
    restoreRow: {
      position: "absolute",
      top: 10,
      left: 0,
      right: 0,
      alignItems: "center",
    },
    restore: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingVertical: 8,
      paddingHorizontal: 14,
      borderRadius: 999,
      backgroundColor: theme.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      ...cardElevation(theme),
    },
    restoreLabel: {
      color: theme.text,
      fontSize: 13,
      fontWeight: "700",
    },
    body: {
      flex: 1,
    },
    displayBar: {
      backgroundColor: theme.toolbar,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    floatingRow: {
      position: "absolute",
      top: 10,
      right: 10,
      flexDirection: "row",
      gap: 8,
    },
    floatingChip: {
      borderRadius: 999,
      paddingVertical: 7,
      paddingHorizontal: 14,
      backgroundColor: theme.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      ...cardElevation(theme),
    },
    floatingChipLabel: {
      color: theme.text,
      fontSize: 13,
      fontWeight: "700",
    },
    tipCard: {
      position: "absolute",
      left: 12,
      right: 12,
      bottom: 12,
      borderRadius: 18,
      padding: 14,
      gap: 6,
      backgroundColor: theme.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      ...cardElevation(theme),
    },
    tipTitle: {
      color: theme.text,
      fontSize: 15,
      fontWeight: "700",
    },
    tipText: {
      color: theme.muted,
      fontSize: 14,
    },
    tipActions: {
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: 20,
      marginTop: 4,
    },
    sheetBackdrop: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: "rgba(0, 0, 0, 0.45)",
      justifyContent: "flex-end",
    },
    sheet: {
      maxHeight: "85%",
      backgroundColor: theme.card,
      borderTopLeftRadius: 18,
      borderTopRightRadius: 18,
      paddingTop: 14,
    },
    sheetHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 18,
      paddingBottom: 10,
    },
    sheetTitle: {
      color: theme.text,
      fontSize: 17,
      fontWeight: "700",
    },
    sheetBody: {
      paddingHorizontal: 18,
      paddingBottom: 24,
      gap: 14,
    },
    sheetHint: {
      color: theme.muted,
      fontSize: 14,
    },
    hiddenInput: {
      position: "absolute",
      left: 0,
      bottom: 0,
      width: 1,
      height: 1,
      opacity: 0,
    },
    displayRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingVertical: 12,
      paddingHorizontal: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    displayRowLast: {
      borderBottomWidth: 0,
    },
    displayLabel: {
      color: theme.text,
      fontSize: 16,
      fontWeight: "500",
    },
    displayValue: {
      color: theme.accent,
      fontSize: 16,
      fontWeight: "600",
    },
    webviewWrap: {
      flex: 1,
      position: "relative",
    },
    webview: {
      flex: 1,
      backgroundColor: theme.bg,
    },
    loadingOverlay: {
      ...StyleSheet.absoluteFillObject,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.bg,
      gap: 12,
    },
    loadingText: {
      color: theme.muted,
      fontSize: 14,
    },
    center: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      padding: 24,
      gap: 12,
    },
    errorTitle: {
      color: theme.text,
      fontSize: 18,
      fontWeight: "700",
    },
    errorDetail: {
      color: theme.muted,
      fontSize: 14,
      textAlign: "center",
    },
    input: {
      width: "100%",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
      backgroundColor: theme.input,
      color: theme.text,
      fontSize: 16,
      marginTop: 4,
    },
    retryButton: {
      borderRadius: 14,
      paddingVertical: 12,
      paddingHorizontal: 24,
      alignItems: "center",
      backgroundColor: theme.accent,
      marginTop: 8,
    },
    retryLabel: {
      color: theme.accentText,
      fontWeight: "700",
    },
  });
}
