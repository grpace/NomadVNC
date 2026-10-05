import { useCallback, useEffect, useRef, useState } from "react";
import type { ViewerCommand } from "@nomadvnc/viewer-shell";
import type { PeerPathInfo } from "@nomadvnc/platform-contracts";
import {
  DEFAULT_MACHINE_VIEW_PREFS,
  type MachineViewPrefs,
} from "../machineViewPrefs";
import {
  isKeyboardGrabSupported,
  releaseKeyboardGrab,
  requestKeyboardGrab,
} from "../keyboardGrab";
import {
  IDLE_BOOST_QUALITY,
  qualityLabelFor,
  suggestAutoQuality,
} from "../autoQuality";
import {
  DISPLAY_REGIONS,
  fitZoomForRegion,
  regionLabel,
  regionRect,
  type DisplayRegion,
} from "../displayRegion";
import {
  CaptureIcon,
  DisconnectIcon,
  FitScreenIcon,
  KeyboardIcon,
  MaximizeIcon,
  MinimizeIcon,
  RefreshIcon,
  SlidersIcon,
} from "./icons";

/** Connection-level viewer states the parent reacts to. */
export type ViewerConnectionState = "connected" | "disconnected" | "credentialsRequired" | "authFailed";

/* ----- noVNC keysyms (X11) ----- */
const XK = {
  Control_L: 0xffe3,
  Alt_L: 0xffe9,
  Shift_L: 0xffe1,
  Super_L: 0xffeb,
  BackSpace: 0xff08,
  Return: 0xff0d,
  Tab: 0xff09,
  Escape: 0xff1b,
  Delete: 0xffff,
  Home: 0xff50,
  Left: 0xff51,
  Up: 0xff52,
  Right: 0xff53,
  Down: 0xff54,
  Page_Up: 0xff55,
  Page_Down: 0xff56,
  End: 0xff57,
  Print: 0xff61,
  Insert: 0xff63,
  Space: 0x0020,
  F1: 0xffbe,
  F2: 0xffbf,
  F3: 0xffc0,
  F4: 0xffc1,
  F5: 0xffc2,
  F6: 0xffc3,
  F7: 0xffc4,
  F8: 0xffc5,
  F9: 0xffc6,
  F10: 0xffc7,
  F11: 0xffc8,
  F12: 0xffc9,
} as const;

interface SpecialKeyDef {
  label: string;
  shortLabel?: string;
  action: ViewerCommand;
}

interface ShortcutSectionDef {
  id: string;
  title: string;
  description: string;
  keys: SpecialKeyDef[];
}

const OS_OPTIONS = ["Windows", "macOS", "Linux"] as const;

const STICKY_KEYS = [
  { label: "Ctrl", keysym: XK.Control_L },
  { label: "Alt", keysym: XK.Alt_L },
  { label: "Shift", keysym: XK.Shift_L },
  { label: "Win/Cmd", keysym: XK.Super_L },
];

const charKey = (char: string) => char.charCodeAt(0);

const UNIVERSAL_SHORTCUT_SECTIONS: ShortcutSectionDef[] = [
  {
    id: "navigation",
    title: "Navigation",
    description: "Directional and focus keys that are useful in every remote OS.",
    keys: [
      { label: "Arrow Up", shortLabel: "Up", action: { type: "sendKeyCombo", modifiers: [], key: XK.Up } },
      { label: "Arrow Down", shortLabel: "Down", action: { type: "sendKeyCombo", modifiers: [], key: XK.Down } },
      { label: "Arrow Left", shortLabel: "Left", action: { type: "sendKeyCombo", modifiers: [], key: XK.Left } },
      { label: "Arrow Right", shortLabel: "Right", action: { type: "sendKeyCombo", modifiers: [], key: XK.Right } },
      { label: "Tab", shortLabel: "Tab", action: { type: "sendKeyCombo", modifiers: [], key: XK.Tab } },
      { label: "Escape", shortLabel: "Esc", action: { type: "sendKeyCombo", modifiers: [], key: XK.Escape } },
      { label: "Enter", shortLabel: "Enter", action: { type: "sendKeyCombo", modifiers: [], key: XK.Return } },
      { label: "Space", shortLabel: "Space", action: { type: "sendKeyCombo", modifiers: [], key: XK.Space } },
    ],
  },
  {
    id: "paging",
    title: "Paging And Editing",
    description: "Helpful for shells, BIOS screens, editors, spreadsheets, and file managers.",
    keys: [
      { label: "Home", shortLabel: "Home", action: { type: "sendKeyCombo", modifiers: [], key: XK.Home } },
      { label: "End", shortLabel: "End", action: { type: "sendKeyCombo", modifiers: [], key: XK.End } },
      { label: "Page Up", shortLabel: "PgUp", action: { type: "sendKeyCombo", modifiers: [], key: XK.Page_Up } },
      { label: "Page Down", shortLabel: "PgDn", action: { type: "sendKeyCombo", modifiers: [], key: XK.Page_Down } },
      { label: "Insert", shortLabel: "Ins", action: { type: "sendKeyCombo", modifiers: [], key: XK.Insert } },
      { label: "Delete", shortLabel: "Del", action: { type: "sendKeyCombo", modifiers: [], key: XK.Delete } },
      { label: "Backspace", shortLabel: "Bksp", action: { type: "sendKeyCombo", modifiers: [], key: XK.BackSpace } },
      { label: "Print Screen", shortLabel: "PrtSc", action: { type: "sendKeyCombo", modifiers: [], key: XK.Print } },
    ],
  },
  {
    id: "function-row",
    title: "Function Row",
    description: "For installers, recovery tools, terminal apps, and classic desktop workflows.",
    keys: [
      { label: "F1", action: { type: "sendKeyCombo", modifiers: [], key: XK.F1 } },
      { label: "F2", action: { type: "sendKeyCombo", modifiers: [], key: XK.F2 } },
      { label: "F3", action: { type: "sendKeyCombo", modifiers: [], key: XK.F3 } },
      { label: "F4", action: { type: "sendKeyCombo", modifiers: [], key: XK.F4 } },
      { label: "F5", action: { type: "sendKeyCombo", modifiers: [], key: XK.F5 } },
      { label: "F6", action: { type: "sendKeyCombo", modifiers: [], key: XK.F6 } },
      { label: "F7", action: { type: "sendKeyCombo", modifiers: [], key: XK.F7 } },
      { label: "F8", action: { type: "sendKeyCombo", modifiers: [], key: XK.F8 } },
      { label: "F9", action: { type: "sendKeyCombo", modifiers: [], key: XK.F9 } },
      { label: "F10", action: { type: "sendKeyCombo", modifiers: [], key: XK.F10 } },
      { label: "F11", action: { type: "sendKeyCombo", modifiers: [], key: XK.F11 } },
      { label: "F12", action: { type: "sendKeyCombo", modifiers: [], key: XK.F12 } },
    ],
  },
];

const OS_KEYS: Record<(typeof OS_OPTIONS)[number], ShortcutSectionDef[]> = {
  Windows: [
    {
      id: "windows-system",
      title: "Windows System",
      description: "Security and task switching commands for Windows desktops and servers.",
      keys: [
        { label: "Ctrl + Alt + Del", shortLabel: "C+A+D", action: { type: "sendKeyCombo", modifiers: [XK.Control_L, XK.Alt_L], key: XK.Delete } },
        { label: "Task Manager", shortLabel: "TaskMgr", action: { type: "sendKeyCombo", modifiers: [XK.Control_L, XK.Shift_L], key: XK.Escape } },
        { label: "Alt + Tab", shortLabel: "Alt+Tab", action: { type: "sendKeyCombo", modifiers: [XK.Alt_L], key: XK.Tab } },
        { label: "Alt + F4", shortLabel: "Alt+F4", action: { type: "sendKeyCombo", modifiers: [XK.Alt_L], key: XK.F4 } },
        { label: "Win", shortLabel: "Win", action: { type: "sendKeyCombo", modifiers: [], key: XK.Super_L } },
        { label: "Win + Tab", shortLabel: "Win+Tab", action: { type: "sendKeyCombo", modifiers: [XK.Super_L], key: XK.Tab } },
      ],
    },
    {
      id: "windows-shell",
      title: "Windows Shell",
      description: "Launchers and management shortcuts for the Start menu, Explorer, and system tools.",
      keys: [
        { label: "Win + D", shortLabel: "Desktop", action: { type: "sendKeyCombo", modifiers: [XK.Super_L], key: charKey("d") } },
        { label: "Win + E", shortLabel: "Explorer", action: { type: "sendKeyCombo", modifiers: [XK.Super_L], key: charKey("e") } },
        { label: "Win + I", shortLabel: "Settings", action: { type: "sendKeyCombo", modifiers: [XK.Super_L], key: charKey("i") } },
        { label: "Win + L", shortLabel: "Lock", action: { type: "sendKeyCombo", modifiers: [XK.Super_L], key: charKey("l") } },
        { label: "Win + R", shortLabel: "Run", action: { type: "sendKeyCombo", modifiers: [XK.Super_L], key: charKey("r") } },
        { label: "Win + X", shortLabel: "Power", action: { type: "sendKeyCombo", modifiers: [XK.Super_L], key: charKey("x") } },
      ],
    },
  ],
  macOS: [
    {
      id: "mac-app-control",
      title: "macOS App Control",
      description: "Common app switching and window commands for Mac sessions.",
      keys: [
        { label: "Cmd + Space", shortLabel: "Spotlight", action: { type: "sendKeyCombo", modifiers: [XK.Super_L], key: XK.Space } },
        { label: "Cmd + Tab", shortLabel: "Cmd+Tab", action: { type: "sendKeyCombo", modifiers: [XK.Super_L], key: XK.Tab } },
        { label: "Cmd + Q", shortLabel: "Quit", action: { type: "sendKeyCombo", modifiers: [XK.Super_L], key: charKey("q") } },
        { label: "Cmd + W", shortLabel: "CloseWin", action: { type: "sendKeyCombo", modifiers: [XK.Super_L], key: charKey("w") } },
        { label: "Cmd + H", shortLabel: "Hide", action: { type: "sendKeyCombo", modifiers: [XK.Super_L], key: charKey("h") } },
        { label: "Cmd + M", shortLabel: "Minimize", action: { type: "sendKeyCombo", modifiers: [XK.Super_L], key: charKey("m") } },
      ],
    },
    {
      id: "mac-system",
      title: "macOS System",
      description: "System-level actions for force quit, screenshots, locking, and preferences.",
      keys: [
        { label: "Cmd + Option + Esc", shortLabel: "ForceQuit", action: { type: "sendKeyCombo", modifiers: [XK.Super_L, XK.Alt_L], key: XK.Escape } },
        { label: "Cmd + Shift + 3", shortLabel: "Shot Full", action: { type: "sendKeyCombo", modifiers: [XK.Super_L, XK.Shift_L], key: charKey("3") } },
        { label: "Cmd + Shift + 4", shortLabel: "Shot Area", action: { type: "sendKeyCombo", modifiers: [XK.Super_L, XK.Shift_L], key: charKey("4") } },
        { label: "Ctrl + Cmd + Q", shortLabel: "Lock", action: { type: "sendKeyCombo", modifiers: [XK.Control_L, XK.Super_L], key: charKey("q") } },
        { label: "Cmd + ,", shortLabel: "Prefs", action: { type: "sendKeyCombo", modifiers: [XK.Super_L], key: charKey(",") } },
        { label: "Cmd + N", shortLabel: "New", action: { type: "sendKeyCombo", modifiers: [XK.Super_L], key: charKey("n") } },
      ],
    },
  ],
  Linux: [
    {
      id: "linux-session",
      title: "Linux Session",
      description: "Common Linux desktop shortcuts that tend to work across GNOME, KDE, and similar environments.",
      keys: [
        { label: "Ctrl + Alt + T", shortLabel: "Terminal", action: { type: "sendKeyCombo", modifiers: [XK.Control_L, XK.Alt_L], key: charKey("t") } },
        { label: "Ctrl + Alt + L", shortLabel: "Lock", action: { type: "sendKeyCombo", modifiers: [XK.Control_L, XK.Alt_L], key: charKey("l") } },
        { label: "Ctrl + Alt + Del", shortLabel: "Logout", action: { type: "sendKeyCombo", modifiers: [XK.Control_L, XK.Alt_L], key: XK.Delete } },
        { label: "Alt + Tab", shortLabel: "Alt+Tab", action: { type: "sendKeyCombo", modifiers: [XK.Alt_L], key: XK.Tab } },
        { label: "Alt + F2", shortLabel: "Run", action: { type: "sendKeyCombo", modifiers: [XK.Alt_L], key: XK.F2 } },
        { label: "Alt + F4", shortLabel: "Close", action: { type: "sendKeyCombo", modifiers: [XK.Alt_L], key: XK.F4 } },
      ],
    },
    {
      id: "linux-shell",
      title: "Linux Shell",
      description: "Useful Super-key actions for launchers, tiling, and workspace-oriented desktop shells.",
      keys: [
        { label: "Super", shortLabel: "Super", action: { type: "sendKeyCombo", modifiers: [], key: XK.Super_L } },
        { label: "Super + D", shortLabel: "Desktop", action: { type: "sendKeyCombo", modifiers: [XK.Super_L], key: charKey("d") } },
        { label: "Super + L", shortLabel: "Lock", action: { type: "sendKeyCombo", modifiers: [XK.Super_L], key: charKey("l") } },
        { label: "Super + Left", shortLabel: "Tile Left", action: { type: "sendKeyCombo", modifiers: [XK.Super_L], key: XK.Left } },
        { label: "Super + Right", shortLabel: "Tile Right", action: { type: "sendKeyCombo", modifiers: [XK.Super_L], key: XK.Right } },
        { label: "Print Screen", shortLabel: "PrtSc", action: { type: "sendKeyCombo", modifiers: [], key: XK.Print } },
      ],
    },
  ],
};

interface ResolutionDef {
  label: string;
  shortLabel?: string;
  width: number;
  height: number;
}

const RESOLUTIONS: ResolutionDef[] = [
  { label: "1024 x 768", width: 1024, height: 768 },
  { label: "1280 x 720", width: 1280, height: 720 },
  { label: "1280 x 800", width: 1280, height: 800 },
  { label: "1440 x 900", width: 1440, height: 900 },
  { label: "1600 x 900", width: 1600, height: 900 },
  { label: "1920 x 1080", width: 1920, height: 1080 },
  { label: "2560 x 1440", width: 2560, height: 1440 },
  { label: "3840 x 2160", width: 3840, height: 2160 },
];

type ScaleMode = "fit" | "actual" | "zoom";

interface QualityPreset {
  label: string;
  value: number;
  description: string;
}

const QUALITY_PRESETS: QualityPreset[] = [
  { label: "Auto", value: 6, description: "Balanced quality" },
  { label: "Low", value: 2, description: "Fast, low bandwidth" },
  { label: "Medium", value: 5, description: "Good for most connections" },
  { label: "High", value: 8, description: "Crisp, higher bandwidth" },
  { label: "Lossless", value: 9, description: "Best quality" },
];

const ZOOM_PRESETS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2];

interface ActiveSession {
  sessionId: string;
  wsUrl: string;
  password?: string;
  vncUsername?: string;
  machineId?: string;
  label: string;
  host: string;
  port: number;
}

interface ViewerPanelProps {
  session: ActiveSession;
  viewerHtml: string;
  isFullscreen: boolean;
  /** Remounts the viewer iframe when changed (reconnects reuse the same URL). */
  sessionKey: string | number;
  /** True after the viewer reports a dropped connection for the active session. */
  connectionLost?: boolean;
  /** The session failed before its first handshake ("couldn't connect", not "lost"). */
  neverConnected?: boolean;
  /** True while a reconnect attempt is establishing a fresh proxy session. */
  isReconnecting?: boolean;
  onDisconnect: () => void;
  onReconnect?: () => void;
  /** Forwards noVNC connection-state transitions so the host can track drops. */
  onViewerState?: (state: ViewerConnectionState) => void;
  /** noVNC could not complete auth (e.g. macOS ARD needs username + password). */
  onCredentialsRequired?: () => void;
  onToggleFullscreen: () => void;
  onRefocusViewer: () => void;
  /** Stable key for the viewed machine (or session); resets view state when it changes. */
  viewPrefsKey?: string;
  /** Per-machine view prefs applied on mount / when `viewPrefsKey` changes. */
  initialViewPrefs?: MachineViewPrefs;
  /** Called whenever scale, zoom, quality, OS-tab, or capture-keys prefs change. */
  onViewPrefsChange?: (prefs: MachineViewPrefs) => void;
  /**
   * Tailnet path verdict for the session host. `undefined` while the first
   * sample is loading, `null` when diagnostics are unavailable.
   */
  connectionPath?: PeerPathInfo | null;
}

function formatPathLatency(path: PeerPathInfo): string {
  return typeof path.latencyMs === "number" ? ` · ${path.latencyMs}ms` : "";
}

function ConnectionPathBadge({ path }: { path: PeerPathInfo | null | undefined }) {
  if (path === undefined) {
    return (
      <span className="live-badge live-badge--checking connection-path">
        <span className="live-badge-dot" />
        Checking…
      </span>
    );
  }
  if (path === null) {
    return null;
  }
  if (!path.found) {
    return (
      <span className="live-badge live-badge--relay connection-path" title="The host was not found on the tailnet">
        <span className="live-badge-dot" />
        Not on Tailnet
      </span>
    );
  }
  if (path.path === "direct") {
    return (
      <span
        className="live-badge connection-path"
        title={path.endpoint ? `Direct UDP path via ${path.endpoint}` : "Direct UDP path, no relay"}
      >
        <span className="live-badge-dot" />
        Direct{formatPathLatency(path)}
      </span>
    );
  }
  if (path.path === "relay") {
    const via = path.relayRegion ? ` · ${path.relayRegion}` : "";
    return (
      <span
        className="live-badge live-badge--relay connection-path"
        title="Relayed through a DERP server. Expect higher latency than a direct path."
      >
        <span className="live-badge-dot" />
        Relayed{via}{formatPathLatency(path)}
      </span>
    );
  }
  return (
    <span className="live-badge live-badge--checking connection-path">
      <span className="live-badge-dot" />
      Path unknown
    </span>
  );
}

type OpenPanel = "keys" | "settings" | "zoom" | null;

export function ViewerPanel({
  session,
  viewerHtml,
  isFullscreen,
  sessionKey,
  connectionLost = false,
  neverConnected = false,
  isReconnecting = false,
  onDisconnect,
  onReconnect,
  onViewerState,
  onCredentialsRequired,
  onToggleFullscreen,
  onRefocusViewer,
  viewPrefsKey,
  initialViewPrefs,
  onViewPrefsChange,
  connectionPath,
}: ViewerPanelProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const prefs = initialViewPrefs ?? DEFAULT_MACHINE_VIEW_PREFS;
  const [scaleMode, setScaleMode] = useState<ScaleMode>(prefs.scaleMode);
  const [zoomLevel, setZoomLevel] = useState(prefs.zoomLevel);
  const [qualityLevel, setQualityLevel] = useState(prefs.quality);
  const [openPanel, setOpenPanel] = useState<OpenPanel>(null);
  const [syncClipboard, setSyncClipboard] = useState(true);
  const [viewerConnected, setViewerConnected] = useState(false);
  const [activeOS, setActiveOS] = useState<(typeof OS_OPTIONS)[number]>(prefs.osTab);
  const [captureKeys, setCaptureKeys] = useState(prefs.captureKeys);
  const [autoQuality, setAutoQuality] = useState(prefs.autoQuality);
  /** Boosted to lossless while idle; cleared on the next input. */
  const [idleBoosted, setIdleBoosted] = useState(false);
  /** Whether the OS-level key grab is actually held (vs merely preferred). */
  const [grabActive, setGrabActive] = useState(false);
  const grabSupported = isKeyboardGrabSupported();
  const [stickyStates, setStickyStates] = useState<Record<number, boolean>>({});
  const [resizeSession, setResizeSession] = useState(false);
  const [currentResolution, setCurrentResolution] = useState({ width: 0, height: 0 });
  const [activeShortcutSection, setActiveShortcutSection] = useState("navigation");
  const [displayRegion, setDisplayRegion] = useState<DisplayRegion>(prefs.displayRegion ?? "full");
  const surfaceRef = useRef<HTMLDivElement>(null);
  const displayRegionRef = useRef<DisplayRegion>(prefs.displayRegion ?? "full");
  useEffect(() => {
    displayRegionRef.current = displayRegion;
  }, [displayRegion]);
  const regionAutoApplied = useRef(false);

  // Reset view state when the viewed machine changes so per-machine prefs apply.
  useEffect(() => {
    const next = initialViewPrefs ?? DEFAULT_MACHINE_VIEW_PREFS;
    setScaleMode(next.scaleMode);
    setZoomLevel(next.zoomLevel);
    setQualityLevel(next.quality);
    setActiveOS(next.osTab);
    setCaptureKeys(next.captureKeys);
    setAutoQuality(next.autoQuality);
    setIdleBoosted(false);
    setDisplayRegion(next.displayRegion ?? "full");
    regionAutoApplied.current = false;
    if (next.captureKeys) {
      // Best-effort: re-assert a remembered grab; the button shows the truth.
      void requestKeyboardGrab().then((grabbed) => setGrabActive(grabbed));
    } else {
      releaseKeyboardGrab();
      setGrabActive(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewPrefsKey]);

  // Never leak a held grab past the session.
  useEffect(() => () => {
    releaseKeyboardGrab();
  }, []);

  const syncClipboardRef = useRef(syncClipboard);
  useEffect(() => {
    syncClipboardRef.current = syncClipboard;
  }, [syncClipboard]);
  const lastLocalClipboard = useRef("");
  const autoQualityRef = useRef(autoQuality);
  useEffect(() => {
    autoQualityRef.current = autoQuality;
  }, [autoQuality]);
  const effectiveQualityRef = useRef(qualityLevel);
  const idleBoostedRef = useRef(idleBoosted);
  useEffect(() => {
    idleBoostedRef.current = idleBoosted;
  }, [idleBoosted]);

  const sendCommand = useCallback((cmd: ViewerCommand) => {
    const iframe = iframeRef.current;
    if (iframe?.contentWindow) {
      iframe.contentWindow.postMessage(cmd, "*");
    }
  }, []);

  // Effective quality: auto degrades the manual ceiling on slow links.
  const effectiveQuality = autoQuality
    ? (suggestAutoQuality(connectionPath, qualityLevel) ?? qualityLevel)
    : qualityLevel;
  useEffect(() => {
    effectiveQualityRef.current = effectiveQuality;
  }, [effectiveQuality]);

  // Apply the effective quality whenever it changes (idle boosts bypass this).
  useEffect(() => {
    if (idleBoostedRef.current) {
      return;
    }
    sendCommand({ type: "setQuality", quality: effectiveQuality });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveQuality]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      const data = event.data;
      if (!data || typeof data.type !== "string") return;

      switch (data.type) {
        case "viewerReady":
          setViewerConnected(true);
          break;
        case "viewerState":
          if (data.state === "credentialsRequired") {
            onCredentialsRequired?.();
          }
          setViewerConnected(data.state === "connected");
          if (
            data.state === "connected"
            || data.state === "disconnected"
            || data.state === "credentialsRequired"
            || data.state === "authFailed"
          ) {
            onViewerState?.(data.state);
          }
          break;
        case "viewerClipboard":
          if (syncClipboardRef.current) {
            const newText = data.text ?? "";
            lastLocalClipboard.current = newText;
            window.nomadNative.writeClipboard(newText).catch(() => {});
          }
          break;
        case "viewerResize":
          setCurrentResolution({ width: data.width, height: data.height });
          break;
        case "viewerActive":
          if (idleBoostedRef.current) {
            setIdleBoosted(false);
            sendCommand({ type: "setQuality", quality: effectiveQualityRef.current });
          }
          break;
        case "viewerIdle":
          if (autoQualityRef.current && !idleBoostedRef.current
            && effectiveQualityRef.current < IDLE_BOOST_QUALITY) {
            setIdleBoosted(true);
            sendCommand({ type: "setQuality", quality: IDLE_BOOST_QUALITY });
          }
          break;
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onCredentialsRequired, onViewerState]);

  function handleSetScaleMode(mode: ScaleMode) {
    setScaleMode(mode);
    setDisplayRegion("full");
    if (mode !== "zoom") {
      setOpenPanel((current) => (current === "zoom" ? null : current));
    }
    sendCommand({ type: "setScaleMode", mode });
    onViewPrefsChange?.({ scaleMode: mode, zoomLevel, quality: qualityLevel, osTab: activeOS, captureKeys, autoQuality, displayRegion: "full" });
    onRefocusViewer();
  }

  function handleSetZoom(level: number) {
    setScaleMode("zoom");
    setZoomLevel(level);
    setDisplayRegion("full");
    sendCommand({ type: "setScaleMode", mode: "zoom", zoomLevel: level });
    onViewPrefsChange?.({ scaleMode: "zoom", zoomLevel: level, quality: qualityLevel, osTab: activeOS, captureKeys, autoQuality, displayRegion: "full" });
    onRefocusViewer();
  }

  /**
   * Monitor-half views: the viewer zooms the region to fit and pans to it
   * (`setDisplayRegion`). Regions imply zoom mode; "full" returns to fit.
   * VNC remotes every monitor as one spanning framebuffer, so halves are
   * the honest client-side version of a monitor picker.
   */
  function applyDisplayRegion(region: DisplayRegion): void {
    if (region === "full") {
      handleSetScaleMode("fit");
      return;
    }
    const fb = { width: currentResolution.width, height: currentResolution.height };
    if (fb.width <= 0 || fb.height <= 0) {
      return;
    }
    // The zoom is only for the toolbar label and saved prefs; the viewer
    // computes the exact fit itself.
    const surface = surfaceRef.current;
    const zoom = fitZoomForRegion(
      { width: surface?.clientWidth ?? 0, height: surface?.clientHeight ?? 0 },
      regionRect(fb, region),
    );
    setDisplayRegion(region);
    setScaleMode("zoom");
    setZoomLevel(zoom);
    sendCommand({ type: "setDisplayRegion", region });
    onViewPrefsChange?.({ scaleMode: "zoom", zoomLevel: zoom, quality: qualityLevel, osTab: activeOS, captureKeys, autoQuality, displayRegion: region });
    onRefocusViewer();
  }

  // Auto-apply a remembered region once the framebuffer size is known.
  useEffect(() => {
    if (regionAutoApplied.current || currentResolution.width <= 0) {
      return;
    }
    regionAutoApplied.current = true;
    if (displayRegionRef.current !== "full") {
      applyDisplayRegion(displayRegionRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentResolution]);

  function handleSetQuality(quality: number) {
    setQualityLevel(quality);
    setIdleBoosted(false);
    sendCommand({ type: "setQuality", quality });
    onViewPrefsChange?.({ scaleMode, zoomLevel, quality, osTab: activeOS, captureKeys, autoQuality, displayRegion });
    onRefocusViewer();
  }

  function handleToggleAutoQuality(enabled: boolean) {
    setAutoQuality(enabled);
    setIdleBoosted(false);
    if (!enabled) {
      sendCommand({ type: "setQuality", quality: qualityLevel });
    }
    onViewPrefsChange?.({ scaleMode, zoomLevel, quality: qualityLevel, osTab: activeOS, captureKeys, autoQuality: enabled, displayRegion });
    onRefocusViewer();
  }

  function handleSetOsTab(os: (typeof OS_OPTIONS)[number]) {
    setActiveOS(os);
    onViewPrefsChange?.({ scaleMode, zoomLevel, quality: qualityLevel, osTab: os, captureKeys, autoQuality, displayRegion });
  }

  /** Capture toggle: grab Super / Alt-Tab / function keys for the remote session. */
  async function handleToggleCaptureKeys(): Promise<void> {
    if (grabActive) {
      releaseKeyboardGrab();
      setGrabActive(false);
      setCaptureKeys(false);
      onViewPrefsChange?.({ scaleMode, zoomLevel, quality: qualityLevel, osTab: activeOS, captureKeys: false, autoQuality, displayRegion });
      onRefocusViewer();
      return;
    }
    setCaptureKeys(true);
    onViewPrefsChange?.({ scaleMode, zoomLevel, quality: qualityLevel, osTab: activeOS, captureKeys: true, autoQuality, displayRegion });
    const grabbed = await requestKeyboardGrab();
    setGrabActive(grabbed);
    onRefocusViewer();
  }

  function handleToggleResize(enabled: boolean) {
    setResizeSession(enabled);
    sendCommand({ type: "setResizeSession", enabled });
    onRefocusViewer();
  }

  function handleSetResolution(width: number, height: number) {
    if (resizeSession) {
      setResizeSession(false);
      sendCommand({ type: "setResizeSession", enabled: false });
    }
    sendCommand({ type: "setResolution", width, height });
    onRefocusViewer();
  }

  function handleSendKey(cmd: ViewerCommand) {
    sendCommand(cmd);
    onRefocusViewer();
  }

  function toggleStickyKey(keysym: number) {
    const nextDown = !stickyStates[keysym];
    setStickyStates((prev) => ({ ...prev, [keysym]: nextDown }));
    sendCommand({ type: "setKeyStates", keys: [{ keysym, down: nextDown }] });
    onRefocusViewer();
  }

  function clearStickyKeys() {
    const keys = Object.entries(stickyStates)
      .filter(([, down]) => down)
      .map(([keysym]) => ({ keysym: Number(keysym), down: false }));

    if (keys.length === 0) {
      return;
    }

    setStickyStates({});
    sendCommand({ type: "setKeyStates", keys });
    onRefocusViewer();
  }

  useEffect(() => {
    if (!syncClipboard) return;
    const interval = window.setInterval(() => {
      window.nomadNative.readClipboard()
        .then((text) => {
          if (text && text !== lastLocalClipboard.current) {
            lastLocalClipboard.current = text;
            sendCommand({ type: "clipboardPaste", text });
          }
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(interval);
  }, [syncClipboard, sendCommand]);

  function togglePanel(panel: OpenPanel) {
    setOpenPanel((current) => current === panel ? null : panel);
  }

  const iconSize = { width: 15, height: 15 };
  const activeStickyCount = Object.values(stickyStates).filter(Boolean).length;
  const shortcutSections = [...UNIVERSAL_SHORTCUT_SECTIONS, ...OS_KEYS[activeOS]];
  const shortcutSectionIndex = Math.max(0, shortcutSections.findIndex((section) => section.id === activeShortcutSection));
  const currentShortcutSection = shortcutSections[shortcutSectionIndex] ?? shortcutSections[0];

  useEffect(() => {
    setActiveShortcutSection("navigation");
  }, [activeOS]);

  return (
    <div className={`viewer-frame ${isFullscreen ? "viewer-frame--fullscreen" : ""}`}>
      {isFullscreen && <div className="fullscreen-trigger" />}

      <div className="viewer-toolbar">
        {!isFullscreen && (
          <div className="viewer-toolbar-info">
            <div className="viewer-toolbar-label">
              <h2>{session.label}</h2>
              {viewerConnected && (
                <span className="live-badge">
                  <span className="live-badge-dot" />
                  Live
                </span>
              )}
              <ConnectionPathBadge path={connectionPath} />
            </div>
            <p className="viewer-toolbar-host">
              {session.host}:{session.port}
              {currentResolution.width > 0 && ` (${currentResolution.width}x${currentResolution.height})`}
            </p>
          </div>
        )}

        <div className="viewer-toolbar-actions">
          {!isFullscreen && (
            <div className="toolbar-group">
              <button
                className={`btn btn--toolbar ${scaleMode === "fit" ? "btn--toolbar-active" : ""}`}
                onClick={() => handleSetScaleMode("fit")}
                title="Fit to Window"
              >
                <FitScreenIcon style={iconSize} />
              </button>
              <button
                className={`btn btn--toolbar ${scaleMode === "actual" ? "btn--toolbar-active" : ""}`}
                onClick={() => handleSetScaleMode("actual")}
                title="Actual Size (1:1)"
              >
                1:1
              </button>
              <button
                className={`btn btn--toolbar ${scaleMode === "zoom" ? "btn--toolbar-active" : ""}`}
                onClick={() => togglePanel("zoom")}
                title="Zoom Level"
              >
                {displayRegion !== "full"
                  ? regionLabel(displayRegion)
                  : scaleMode === "zoom"
                    ? `${Math.round(zoomLevel * 100)}%`
                    : "Zoom"}
              </button>
            </div>
          )}

          {!isFullscreen && <div className="toolbar-divider" />}

          <button
            className={`btn btn--toolbar ${openPanel === "keys" ? "btn--toolbar-active" : ""}`}
            onClick={() => togglePanel("keys")}
            title="Keyboard Shortcuts"
          >
            <KeyboardIcon style={iconSize} />
            {isFullscreen && <span className="btn-text">Shortcuts</span>}
          </button>

          <button
            className={`btn btn--toolbar ${grabActive ? "btn--toolbar-active" : ""}`}
            onClick={() => void handleToggleCaptureKeys()}
            disabled={!grabSupported}
            title={
              grabSupported
                ? grabActive
                  ? "Release captured keys (Esc also exits capture)"
                  : "Capture keys: send Super, Alt-Tab, and function keys to the remote session instead of the host"
                : "Keyboard capture is not supported in this environment"
            }
          >
            <CaptureIcon style={iconSize} />
            <span className="btn-text">Capture</span>
          </button>

          {!isFullscreen && (
            <button
              className={`btn btn--toolbar ${openPanel === "settings" ? "btn--toolbar-active" : ""}`}
              onClick={() => togglePanel("settings")}
              title="Session Settings"
            >
              <SlidersIcon style={iconSize} />
            </button>
          )}

          <div className="toolbar-divider" />

          <button
            className={`btn btn--toolbar ${isFullscreen ? "btn--toolbar-active" : ""}`}
            onClick={onToggleFullscreen}
            title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
          >
            {isFullscreen ? <MinimizeIcon style={iconSize} /> : <MaximizeIcon style={iconSize} />}
            <span className="btn-text">{isFullscreen ? "Exit Fullscreen" : "Fullscreen"}</span>
          </button>

          <div className="toolbar-divider" />

          {connectionLost && (
            <button
              className={`btn ${isFullscreen ? "btn--toolbar" : "btn--primary btn--sm"}`}
              onClick={onReconnect}
              disabled={isReconnecting}
              title="Reconnect to This Session"
            >
              <RefreshIcon style={iconSize} />
              <span className="btn-text">{isReconnecting ? "Reconnecting…" : "Reconnect"}</span>
            </button>
          )}

          <button
            className={`btn ${isFullscreen ? "btn--toolbar" : "btn--danger btn--sm"}`}
            onClick={onDisconnect}
            title="Disconnect Session"
          >
            <DisconnectIcon style={iconSize} />
            <span className="btn-text">Disconnect</span>
          </button>
        </div>
      </div>

      {openPanel === "zoom" && (
        <div className="viewer-dropdown viewer-dropdown--zoom">
          <div className="viewer-dropdown-col">
            <label className="viewer-dropdown-label">Zoom Level</label>
            <p className="viewer-dropdown-desc">Scale the remote screen. When it's larger than the window, hold the pointer at an edge to pan.</p>
            <div className="viewer-dropdown-zoom-grid">
              {ZOOM_PRESETS.map((preset) => (
                <button
                  key={preset}
                  className={`btn btn--sm ${scaleMode === "zoom" && zoomLevel === preset ? "btn--primary" : "btn--secondary"}`}
                  onClick={() => handleSetZoom(preset)}
                  title={`Zoom to ${Math.round(preset * 100)} percent`}
                >
                  {Math.round(preset * 100)}%
                </button>
              ))}
            </div>
          </div>
          <div className="viewer-dropdown-col">
            <label className="viewer-dropdown-label">Monitor Area</label>
            <p className="viewer-dropdown-desc">Split a multi-monitor span into viewable halves.</p>
            <div className="viewer-dropdown-zoom-grid viewer-dropdown-zoom-grid--region">
              {DISPLAY_REGIONS.map((region) => (
                <button
                  key={region}
                  className={`btn btn--sm ${displayRegion === region ? "btn--primary" : "btn--secondary"}`}
                  onClick={() => applyDisplayRegion(region)}
                  disabled={region !== "full" && currentResolution.width <= 0}
                  title={region === "full" ? "Show the full remote display" : `View the ${regionLabel(region).toLowerCase()} of the remote display`}
                >
                  {regionLabel(region)}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {openPanel === "keys" && (
        <div className="viewer-dropdown viewer-dropdown--keys">
          <div className="viewer-dropdown-grid-cols viewer-dropdown-grid-cols--keys">
            <div className="viewer-dropdown-col">
              <div className="viewer-dropdown-section-header">
                <div>
                  <label className="viewer-dropdown-label">Sticky Modifiers</label>
                  <p className="viewer-dropdown-desc">Keep modifier keys depressed while you send any shortcut below.</p>
                </div>
                <button
                  className="btn btn--secondary btn--sm viewer-dropdown-clear"
                  onClick={clearStickyKeys}
                  disabled={activeStickyCount === 0}
                >
                  Clear
                </button>
              </div>

              <div className="viewer-dropdown-sticky-summary">
                {activeStickyCount === 0 ? "No modifiers latched" : `${activeStickyCount} modifier${activeStickyCount === 1 ? "" : "s"} latched`}
              </div>

              <div className="viewer-dropdown-sticky-grid">
                {STICKY_KEYS.map((key) => (
                  <button
                    key={key.keysym}
                    className={`btn btn--sm sticky-btn ${stickyStates[key.keysym] ? "sticky-btn--active" : "btn--secondary"}`}
                    onClick={() => toggleStickyKey(key.keysym)}
                  >
                    {key.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="toolbar-divider" />

            <div className="viewer-dropdown-col">
              <div className="viewer-dropdown-tabs">
                {OS_OPTIONS.map((os) => (
                  <button
                    key={os}
                    className={`tab-btn ${activeOS === os ? "tab-btn--active" : ""}`}
                    onClick={() => handleSetOsTab(os)}
                  >
                    {os}
                  </button>
                ))}
              </div>

              <div className="viewer-shortcut-pager">
                <button
                  className="btn btn--secondary btn--sm viewer-shortcut-nav"
                  onClick={() => setActiveShortcutSection(shortcutSections[(shortcutSectionIndex - 1 + shortcutSections.length) % shortcutSections.length].id)}
                  title="Previous Shortcut Section"
                >
                  Prev
                </button>
                <div className="viewer-shortcut-pager-meta">
                  <label className="viewer-dropdown-label">{activeOS} · {currentShortcutSection.title}</label>
                  <div className="viewer-shortcut-pager-count">{shortcutSectionIndex + 1} / {shortcutSections.length}</div>
                </div>
                <button
                  className="btn btn--secondary btn--sm viewer-shortcut-nav"
                  onClick={() => setActiveShortcutSection(shortcutSections[(shortcutSectionIndex + 1) % shortcutSections.length].id)}
                  title="Next Shortcut Section"
                >
                  Next
                </button>
              </div>

              <div className="viewer-shortcut-sections-scroll">
                <div className="viewer-shortcut-section">
                  <div className="viewer-dropdown-key-grid">
                    {currentShortcutSection.keys.map((key) => (
                      <button
                        key={key.label}
                        className="btn btn--secondary btn--sm viewer-shortcut-chip"
                        onClick={() => handleSendKey(key.action)}
                        title={`${currentShortcutSection.title}: ${key.label}`}
                      >
                        {key.shortLabel ?? key.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {openPanel === "settings" && (
        <div className="viewer-dropdown">
          <div className="viewer-dropdown-grid-cols">
            <div className="viewer-dropdown-col">
              <label className="viewer-dropdown-label">Session Controls</label>
              <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                <div>
                  <p className="viewer-dropdown-desc">Resize host to match your window</p>
                  <button
                    className={`btn btn--sm ${resizeSession ? "btn--primary" : "btn--secondary"}`}
                    onClick={() => handleToggleResize(!resizeSession)}
                  >
                    {resizeSession ? "Resize Host: ON" : "Resize Host: OFF"}
                  </button>
                </div>
                <div>
                  <p className="viewer-dropdown-desc">Bidirectional clipboard auto-sync</p>
                  <button
                    className={`btn btn--sm ${syncClipboard ? "btn--primary" : "btn--secondary"}`}
                    onClick={() => setSyncClipboard(!syncClipboard)}
                  >
                    {syncClipboard ? "Clipboard Sync: ON" : "Clipboard Sync: OFF"}
                  </button>
                </div>
                <div>
                  <p className="viewer-dropdown-desc">Lower quality automatically on slow links</p>
                  <button
                    className={`btn btn--sm ${autoQuality ? "btn--primary" : "btn--secondary"}`}
                    onClick={() => handleToggleAutoQuality(!autoQuality)}
                  >
                    {autoQuality ? "Auto Quality: ON" : "Auto Quality: OFF"}
                  </button>
                </div>
              </div>
            </div>

            <div className="toolbar-divider" />

            <div className="viewer-dropdown-quality-res-pair">
              <div className="viewer-dropdown-col viewer-dropdown-col--quality-res">
                <label className="viewer-dropdown-label">Image Quality</label>
                {autoQuality && effectiveQuality !== qualityLevel && (
                  <p className="viewer-dropdown-desc viewer-auto-quality-note">
                    Auto: {qualityLabelFor(effectiveQuality)}{idleBoosted ? " (sharpening while idle)" : ""}
                  </p>
                )}
                <div className="viewer-dropdown-quality">
                  {QUALITY_PRESETS.map((preset) => (
                    <button
                      key={preset.label}
                      className={`quality-option ${qualityLevel === preset.value ? "quality-option--active" : ""}`}
                      onClick={() => handleSetQuality(preset.value)}
                    >
                      <span className="quality-option-label">{preset.label}</span>
                      <span className="quality-option-desc">{preset.description}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="viewer-dropdown-col viewer-dropdown-col--quality-res">
                <label className="viewer-dropdown-label">Quick Resolution</label>
                <div className="viewer-dropdown-res-scroll">
                  <div className="viewer-dropdown-res-grid">
                    {RESOLUTIONS.map((res) => (
                      <button
                        key={res.label}
                        className="btn btn--secondary btn--sm"
                        onClick={() => handleSetResolution(res.width, res.height)}
                      >
                        {res.shortLabel ?? res.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      <div
        ref={surfaceRef}
        className={`viewer-surface ${scaleMode === "actual" ? "viewer-surface--actual" : ""} ${scaleMode === "zoom" ? "viewer-surface--zoom" : ""}`}
        onClick={() => sendCommand({ type: "focus" })}
      >
        {connectionLost && (
          <div className="viewer-reconnect-overlay" role="alert">
            <div className="viewer-reconnect-card">
              <p className="viewer-reconnect-title">{neverConnected ? "Couldn't Connect" : "Connection Lost"}</p>
              <p className="viewer-reconnect-desc">
                {neverConnected
                  ? `Nothing answered at ${session.host}:${session.port}. Check that the VNC server is running and the port is right, then try again.`
                  : `The remote session dropped. Reconnect to ${session.label} or disconnect to end the session.`}
              </p>
              <button
                className="btn btn--primary btn--sm"
                onClick={onReconnect}
                disabled={isReconnecting}
              >
                {isReconnecting
                  ? neverConnected ? "Connecting…" : "Reconnecting…"
                  : neverConnected ? "Try Again" : "Reconnect"}
              </button>
            </div>
          </div>
        )}
        <iframe
          ref={iframeRef}
          key={sessionKey}
          title="NomadVNC Viewer"
          srcDoc={viewerHtml}
          style={scaleMode === "actual" && currentResolution.width > 0 ? {
            width: currentResolution.width,
            height: currentResolution.height,
            flex: "none",
          } : {}}
        />
      </div>
    </div>
  );
}
