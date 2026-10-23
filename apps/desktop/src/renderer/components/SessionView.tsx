import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { PeerDevice, SavedMachine } from "@nomadvnc/domain";
import type { PeerPathInfo } from "@nomadvnc/platform-contracts";
import { createViewerHtml } from "@nomadvnc/viewer-shell";
import viewerBootstrapUrl from "@nomadvnc/viewer-shell/bootstrap?url";
import viewerInputUrl from "@nomadvnc/viewer-shell/input?url";
import type { MachineViewPrefs } from "../machineViewPrefs";
import { formatLastSeenSuffix, getMachinePresence } from "../presence";
import { AUTO_RECONNECT_MAX_ATTEMPTS, SessionReconnectController } from "../sessionReconnect";
import { ViewerPanel, type ViewerConnectionState } from "./ViewerPanel";

export interface ActiveSession {
  sessionId: string;
  wsUrl: string;
  password?: string;
  /** Passed to noVNC for macOS ARD; optional for standard VNC password–only servers. */
  vncUsername?: string;
  machineId?: string;
  label: string;
  host: string;
  port: number;
  /** True when the session targets a user-typed address (local-first path). */
  direct: boolean;
}

/** What the session strip and sidebar show for a session. */
export type SessionLiveState = "live" | "down" | "connecting";

export type SessionStatusVariant = "info" | "success" | "error" | "connecting" | "disconnecting";

export function buildViewerHtml(session: Pick<ActiveSession, "wsUrl" | "password" | "vncUsername">): string {
  return createViewerHtml({
    wsUrl: session.wsUrl,
    password: session.password,
    username: session.vncUsername,
    bootstrapModuleUrl: new URL("./vendor/novnc/core/rfb.js", window.location.href).toString(),
    bootstrapScriptUrl: new URL(viewerBootstrapUrl, window.location.href).toString(),
    inputModuleUrl: new URL(viewerInputUrl, window.location.href).toString(),
    desktop: true,
    fitToScreen: true,
  });
}

interface SessionViewProps {
  slotId: string;
  session: ActiveSession;
  /** Several sessions are open: status lines name the machine. */
  multiSession: boolean;
  /** The session that gets the keyboard grab and clipboard sync. */
  isFocused: boolean;
  /** Grid tile: compact toolbar. */
  compact: boolean;
  isFullscreen: boolean;
  machinesRef: MutableRefObject<SavedMachine[]>;
  peersRef: MutableRefObject<PeerDevice[]>;
  initialViewPrefs: MachineViewPrefs;
  onViewPrefsChange: (machineId: string, prefs: MachineViewPrefs) => void;
  onSessionChange: (slotId: string, session: ActiveSession) => void;
  onLiveStateChange: (slotId: string, state: SessionLiveState) => void;
  /** The session ended (user disconnect or a cancelled password prompt). */
  onClose: (slotId: string) => void;
  onTouchMachine: (machineId: string) => void;
  onStatus: (message: string, variant: SessionStatusVariant) => void;
  /** Clears a "connecting" status once this session is live. */
  onConnectingDone: () => void;
  requestPasswordPrompt: (title: string, body: string, submitLabel?: string) => Promise<string | null>;
  onToggleFullscreen: () => void;
  onExpand?: () => void;
}

/**
 * One remote session: owns its reconnect loop, wrong-password recovery,
 * tailnet path sampling, and the viewer. App mounts one per open session.
 */
export function SessionView({
  slotId,
  session,
  multiSession,
  isFocused,
  compact,
  isFullscreen,
  machinesRef,
  peersRef,
  initialViewPrefs,
  onViewPrefsChange,
  onSessionChange,
  onLiveStateChange,
  onClose,
  onTouchMachine,
  onStatus,
  onConnectingDone,
  requestPasswordPrompt,
  onToggleFullscreen,
  onExpand,
}: SessionViewProps) {
  const [viewerHtml, setViewerHtml] = useState(() => buildViewerHtml(session));
  const [sessionKey, setSessionKey] = useState(0);
  const [connectionLost, setConnectionLost] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  /** True once the viewer finished the RFB handshake; false while (re)connecting. */
  const [viewerLive, setViewerLive] = useState(false);
  /**
   * Whether this session ever completed a handshake. A failure before that
   * is "couldn't connect" (wrong port, server not running): reported at
   * once instead of five "connection lost" retries.
   */
  const everLiveRef = useRef(false);
  const [neverConnected, setNeverConnected] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const sessionRef = useRef(session);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);
  /** Set once the session is ended, so in-flight work doesn't revive it. */
  const closedRef = useRef(false);

  // Parent callbacks change identity every render; the reconnect controller
  // and memoized handlers read them through a ref.
  const propsRef = useRef({ multiSession, onStatus, onClose, onConnectingDone, onLiveStateChange, onSessionChange, onTouchMachine, requestPasswordPrompt });
  propsRef.current = { multiSession, onStatus, onClose, onConnectingDone, onLiveStateChange, onSessionChange, onTouchMachine, requestPasswordPrompt };

  /** Prefixes the machine name when several sessions share the status line. */
  const named = useCallback((message: string): string => (
    propsRef.current.multiSession ? `${sessionRef.current.label}: ${message}` : message
  ), []);

  const liveState: SessionLiveState = viewerLive ? "live" : connectionLost ? "down" : "connecting";
  useEffect(() => {
    propsRef.current.onLiveStateChange(slotId, liveState);
  }, [slotId, liveState]);

  /** Proxy session replaced by a reconnect, stopped after the new viewer mounts. */
  const supersededSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    const superseded = supersededSessionIdRef.current;
    if (!superseded) {
      return;
    }
    supersededSessionIdRef.current = null;
    void Promise.resolve().then(() => window.nomadNative.stopVncSession(superseded)).catch(() => {
      // The old proxy session is already dead; cleanup is best-effort.
    });
  }, [sessionKey]);

  // --- Tailnet path health ---
  const [connectionPath, setConnectionPath] = useState<PeerPathInfo | null | undefined>(undefined);
  /** Re-samples the path now (the viewer says the session stopped answering). */
  const resampleConnectionPathRef = useRef<() => void>(() => {});
  const pathHost = session.host;
  const pathDirect = session.direct;
  const pathSessionId = session.sessionId;
  useEffect(() => {
    // Direct (address) sessions don't ride the tailnet: a path verdict
    // would be meaningless ("No path"), so the chip stays hidden.
    if (pathDirect) {
      setConnectionPath(null);
      return;
    }
    let cancelled = false;

    async function refreshPath(): Promise<void> {
      try {
        if (typeof window.nomadNative.getPeerPath !== "function") {
          if (!cancelled) {
            setConnectionPath(null);
          }
          return;
        }
        const info = await window.nomadNative.getPeerPath(pathHost);
        if (!cancelled) {
          setConnectionPath(info);
        }
      } catch {
        // Diagnostics are advisory; a failed sample hides the chip.
        if (!cancelled) {
          setConnectionPath(null);
        }
      }
    }

    setConnectionPath(undefined);
    void refreshPath();
    resampleConnectionPathRef.current = () => {
      // "Checking…" until the fresh sample lands, so a stale verdict
      // doesn't explain the stall.
      setConnectionPath(undefined);
      void refreshPath();
    };
    const timer = window.setInterval(() => {
      void refreshPath();
    }, 15000);
    return () => {
      cancelled = true;
      resampleConnectionPathRef.current = () => {};
      window.clearInterval(timer);
    };
  }, [pathHost, pathDirect, pathSessionId]);

  // --- Reconnect ---
  const reconnectInFlightRef = useRef(false);

  function machineForSession(): SavedMachine | undefined {
    const current = sessionRef.current;
    return current.machineId
      ? machinesRef.current.find((entry) => entry.id === current.machineId)
      : undefined;
  }

  /**
   * Make-before-break reconnect: start the replacement proxy session first so
   * a failed attempt keeps the (dead) session object intact for another retry.
   * Throws on failure; callers decide whether to retry or surface the error.
   */
  async function runReconnectAttempt(): Promise<void> {
    const previous = sessionRef.current;
    if (closedRef.current || reconnectInFlightRef.current) {
      throw new Error("No session to reconnect");
    }

    reconnectInFlightRef.current = true;
    setIsReconnecting(true);
    try {
      const started = await window.nomadNative.startVncSession({
        host: previous.host,
        port: previous.port,
        sessionToken: crypto.randomUUID(),
        direct: previous.direct,
      });

      if (closedRef.current) {
        // The user disconnected while we were dialing: drop the replacement
        // instead of resurrecting the session.
        try {
          await window.nomadNative.stopVncSession(started.sessionId);
        } catch {
          // Best-effort cleanup.
        }
        return;
      }

      // Stopped once the new viewer has mounted (effect on sessionKey). Stopping
      // it now would let the old, still-mounted viewer report "disconnected"
      // and start the auto-retry loop for a session that is being replaced.
      supersededSessionIdRef.current = previous.sessionId;

      if (previous.machineId) {
        propsRef.current.onTouchMachine(previous.machineId);
      }

      const next: ActiveSession = {
        ...sessionRef.current,
        sessionId: started.sessionId,
        wsUrl: started.wsUrl,
      };
      sessionRef.current = next;
      propsRef.current.onSessionChange(slotId, next);
      setViewerHtml(buildViewerHtml(next));
      // Force the iframe to remount even when the proxy URL is unchanged.
      setSessionKey((key) => key + 1);
    } finally {
      reconnectInFlightRef.current = false;
      setIsReconnecting(false);
    }
  }
  const runReconnectAttemptRef = useRef(runReconnectAttempt);
  runReconnectAttemptRef.current = runReconnectAttempt;

  // Automatic reconnection for transient drops (network flap, VNC server
  // restart). The controller's callbacks only touch refs and state setters,
  // so the lazily created instance stays valid for the component's lifetime.
  const autoReconnectRef = useRef<SessionReconnectController | null>(null);
  if (!autoReconnectRef.current) {
    autoReconnectRef.current = new SessionReconnectController({
      attempt: () => runReconnectAttemptRef.current(),
      onExhausted: () => {
        // Retry budget spent: surface the manual "Connection lost" overlay
        // with an honest diagnosis (peer offline vs. VNC server dead).
        const current = sessionRef.current;
        const machine = machineForSession();
        const presence = machine ? getMachinePresence(machine, peersRef.current) : undefined;
        const target = `${current.host}:${current.port}`;
        setConnectionLost(true);
        if (machine && presence?.kind === "offline") {
          const suffix = formatLastSeenSuffix(presence.peer?.lastSeen);
          propsRef.current.onStatus(
            `Couldn't reconnect to "${machine.label}". It looks offline now${suffix ? ` (${suffix})` : ""}. Reconnect to retry.`,
            "error",
          );
        } else if (machine) {
          propsRef.current.onStatus(
            `Couldn't reconnect to "${machine.label}" after ${AUTO_RECONNECT_MAX_ATTEMPTS} tries. Its VNC server at ${target} may have stopped. Reconnect to retry.`,
            "error",
          );
        } else {
          propsRef.current.onStatus(
            `Couldn't reconnect to ${target} after ${AUTO_RECONNECT_MAX_ATTEMPTS} tries. The VNC server may have stopped. Reconnect to retry.`,
            "error",
          );
        }
      },
      onAttemptScheduled: (attempt) => {
        // Keep the manual overlay hidden while retries are in flight; the
        // status line carries the progress.
        setConnectionLost(false);
        propsRef.current.onStatus(
          named(`Connection lost. Retrying (${attempt}/${AUTO_RECONNECT_MAX_ATTEMPTS})…`),
          "connecting",
        );
      },
      onNetworkOffline: () => {
        // The OS network dropped: pause retries without burning the budget.
        // The loop resumes with a fresh budget when the network returns.
        setConnectionLost(false);
        propsRef.current.onStatus(named("You're offline. Retrying when the network returns…"), "connecting");
      },
    });
  }

  // Pause/resume the retry loop with the OS network. This catches the common
  // "tailnet path died" case (wifi drop, sleep/wake) that tsnet's own
  // logged-in state can't report: tsnet stays "Running" while the path is
  // down, and retries would otherwise burn the budget blaming the VNC server.
  useEffect(() => {
    const handleOffline = (): void => {
      autoReconnectRef.current?.noteNetworkOffline();
    };
    const handleOnline = (): void => {
      autoReconnectRef.current?.noteNetworkOnline();
    };
    window.addEventListener("offline", handleOffline);
    window.addEventListener("online", handleOnline);
    return () => {
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("online", handleOnline);
    };
  }, []);

  useEffect(() => () => {
    closedRef.current = true;
    autoReconnectRef.current?.stop();
  }, []);

  function endSession(): void {
    closedRef.current = true;
    autoReconnectRef.current?.stop();
    propsRef.current.onClose(slotId);
  }

  /** One-click reconnect: establish a fresh proxy session with the same parameters. */
  async function reconnectSession(): Promise<void> {
    autoReconnectRef.current?.stop();
    if (closedRef.current || reconnectInFlightRef.current) {
      return;
    }

    onStatus(`Reconnecting to ${sessionRef.current.label}...`, "connecting");
    try {
      await runReconnectAttempt();
    } catch (error) {
      onStatus(error instanceof Error ? error.message : "Unable to reconnect the VNC session", "error");
    }
  }

  /**
   * Wrong-password recovery. The server rejected the password: ask for a
   * new one and reconnect with it; cancelling ends the session. When the new
   * password gets through and the machine keeps its password in the local
   * keyring, the saved copy is updated so the next connect just works.
   * Held in a ref because the viewer-state callback is memoized once.
   */
  const pendingPasswordUpdateRef = useRef<{ machineId: string; password: string } | null>(null);
  const authRecoveryRef = useRef({ onAuthFailed: async () => {}, onConnected: async () => {} });
  authRecoveryRef.current = {
    onAuthFailed: async () => {
      const current = sessionRef.current;
      if (closedRef.current) {
        return;
      }
      pendingPasswordUpdateRef.current = null;
      onStatus(`"${current.label}" rejected the password`, "error");
      const entered = await requestPasswordPrompt(
        "Wrong Password",
        `"${current.label}" didn't accept that password. Enter it again to reconnect.`,
        "Reconnect",
      );
      if (closedRef.current) {
        return;
      }
      if (entered === null) {
        endSession();
        return;
      }
      const updated: ActiveSession = { ...sessionRef.current, password: entered || undefined };
      sessionRef.current = updated;
      onSessionChange(slotId, updated);
      if (current.machineId && entered) {
        pendingPasswordUpdateRef.current = { machineId: current.machineId, password: entered };
      }
      onStatus(`Reconnecting to ${current.label}...`, "connecting");
      try {
        await runReconnectAttempt();
      } catch (error) {
        onStatus(error instanceof Error ? error.message : "Unable to reconnect the VNC session", "error");
      }
    },
    onConnected: async () => {
      const pending = pendingPasswordUpdateRef.current;
      pendingPasswordUpdateRef.current = null;
      if (!pending) {
        return;
      }
      const machine = machinesRef.current.find((entry) => entry.id === pending.machineId);
      if (machine?.credentialMode === "localSecure") {
        try {
          await window.nomadNative.setMachinePassword(machine.id, pending.password);
          onStatus(`Updated the saved password for ${machine.label}`, "success");
        } catch {
          onStatus(
            `Connected, but couldn't update the saved password for ${machine.label}. Edit the machine to save it.`,
            "error",
          );
        }
      } else if (machine?.credentialMode === "cloudSecure") {
        onStatus(`Connected. Edit ${machine.label} and save to update its synced password.`, "info");
      }
    },
  };

  const handleViewerState = useCallback((state: ViewerConnectionState): void => {
    if (state === "connected") {
      // A completed RFB handshake means the session is healthy: the retry
      // loop (if any) is done and its budget resets.
      autoReconnectRef.current?.noteConnected();
      setConnectionLost(false);
      setViewerLive(true);
      everLiveRef.current = true;
      setNeverConnected(false);
      // "Retrying (1/5)…" and "Reconnecting to …" are over once the viewer
      // is connected; left alone they would sit there for the whole session.
      propsRef.current.onConnectingDone();
      void authRecoveryRef.current.onConnected();
      return;
    }
    setViewerLive(false);
    if (state === "authFailed") {
      // Retrying a rejected password can't succeed (and gets clients
      // blacklisted by many servers): stop the loop and ask instead.
      autoReconnectRef.current?.stop();
      void authRecoveryRef.current.onAuthFailed();
      return;
    }
    if (state === "disconnected" && !closedRef.current) {
      // The TCP dial to the VNC target happens lazily when noVNC connects,
      // so a drop here means either the host went away or its VNC server did.
      const current = sessionRef.current;
      const machine = current.machineId
        ? machinesRef.current.find((entry) => entry.id === current.machineId)
        : undefined;
      const presence = machine ? getMachinePresence(machine, peersRef.current) : undefined;
      if (machine && presence?.kind === "offline") {
        // The peer is gone: retrying is pointless, go straight to manual.
        autoReconnectRef.current?.stop();
        const suffix = formatLastSeenSuffix(presence.peer?.lastSeen);
        setConnectionLost(true);
        propsRef.current.onStatus(
          `Connection to "${machine.label}" lost. It looks offline now${suffix ? ` (${suffix})` : ""}.`,
          "error",
        );
        return;
      }
      if (!everLiveRef.current) {
        // Never got through: retrying the same address won't help, so say
        // what's wrong right away and let the user retry when ready.
        autoReconnectRef.current?.stop();
        setNeverConnected(true);
        setConnectionLost(true);
        propsRef.current.onStatus(`Couldn't connect to ${current.label}`, "error");
        return;
      }
      // Transient-looking drop: retry with backoff. The manual "Connection
      // lost" overlay only appears if the retry budget is exhausted. Each
      // viewer-level failure counts against the same budget — only a
      // successful "connected" resets it.
      autoReconnectRef.current?.noteDisconnected();
    }
    // machinesRef/peersRef are stable refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={wrapperRef} className="session-view">
      <ViewerPanel
        session={session}
        viewerHtml={viewerHtml}
        isFullscreen={isFullscreen && !compact}
        compact={compact}
        isActive={isFocused}
        sessionKey={sessionKey}
        connectionLost={connectionLost}
        neverConnected={neverConnected}
        isReconnecting={isReconnecting}
        viewPrefsKey={session.machineId ?? slotId}
        initialViewPrefs={initialViewPrefs}
        connectionPath={connectionPath}
        onLinkStalled={() => resampleConnectionPathRef.current()}
        onViewPrefsChange={(prefs) => {
          if (session.machineId) {
            onViewPrefsChange(session.machineId, prefs);
          }
        }}
        onDisconnect={endSession}
        onReconnect={() => void reconnectSession()}
        onViewerState={handleViewerState}
        onCredentialsRequired={() =>
          onStatus(
            "Server asked for more credentials (often macOS Screen Sharing). Add your Mac account short name in VNC username, save the machine, and reconnect.",
            "error",
          )
        }
        onToggleFullscreen={onToggleFullscreen}
        onExpand={onExpand}
        onRefocusViewer={() => {
          // Small delay to let toolbar close before refocusing the canvas
          setTimeout(() => {
            const iframe = wrapperRef.current?.querySelector<HTMLIFrameElement>(".viewer-surface iframe");
            iframe?.contentWindow?.postMessage({ type: "focus" }, "*");
          }, 100);
        }}
      />
    </div>
  );
}
