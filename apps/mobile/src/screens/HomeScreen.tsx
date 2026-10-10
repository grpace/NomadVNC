import { useEffect, useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useColorScheme,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import type { PeerDevice, TailnetState } from "@nomadvnc/domain";
import { NomadNativeModule } from "../native/NomadNativeModule";
import { buildConnectInput } from "../connectInput";
import { useAccount } from "../account/AccountContext";
import { SavedDevicesSection } from "../components/SavedDevicesSection";
import { isWebUrl, SIGN_IN_POLL_MS, signInUrlFor } from "../tailnetSignIn";
import { loadLastManualConnection, loadMobileSettings, saveLastManualConnection } from "../settings";

export interface MobileSession {
  sessionId: string;
  wsUrl: string;
  password: string;
  assetBaseUrl: string;
  /** macOS Screen Sharing (ARD) username — viewer-level, like desktop. */
  username?: string;
  /** Saved-device ID for per-device view prefs; undefined for manual/tailnet connects. */
  deviceId?: string;
  /** Connection host, for tailnet path health (auto-quality). */
  host?: string;
  /** Dialed by address, not over the tailnet: no tailnet path to sample. */
  direct?: boolean;
  /** What the viewer title shows: the saved device's label, else the host. */
  label?: string;
}

interface HomeScreenProps {
  onConnect: (payload: MobileSession) => void;
  onLogin: () => void;
  onSettings: () => void;
}

type TailnetStatus =
  | { kind: "idle" }
  | { kind: "starting" }
  | { kind: "ready"; state: TailnetState }
  | { kind: "error"; message: string };

function SettingsIcon({ color }: { color: string }) {
  return (
    <View style={settingsIconStyles.row}>
      <View style={settingsIconStyles.track}>
        <View style={[settingsIconStyles.stem, { backgroundColor: color }]} />
        <View style={[settingsIconStyles.knob, { backgroundColor: color, top: 3 }]} />
      </View>
      <View style={settingsIconStyles.track}>
        <View style={[settingsIconStyles.stem, { backgroundColor: color }]} />
        <View style={[settingsIconStyles.knob, { backgroundColor: color, top: 9 }]} />
      </View>
      <View style={settingsIconStyles.track}>
        <View style={[settingsIconStyles.stem, { backgroundColor: color }]} />
        <View style={[settingsIconStyles.knob, { backgroundColor: color, top: 5 }]} />
      </View>
    </View>
  );
}

const settingsIconStyles = StyleSheet.create({
  row: {
    width: 18,
    height: 16,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  track: {
    width: 4,
    height: 16,
    alignItems: "center",
  },
  stem: {
    width: 1.5,
    height: 16,
    borderRadius: 1,
  },
  knob: {
    position: "absolute",
    width: 4,
    height: 4,
    borderRadius: 1,
  },
});

export function HomeScreen({ onConnect, onLogin, onSettings }: HomeScreenProps) {
  const account = useAccount();
  const signedIn = account.session !== null;
  const insets = useSafeAreaInsets();
  const colorScheme = useColorScheme();
  const isDark = colorScheme !== "light";
  const theme = isDark ? darkTheme : lightTheme;

  const [tailnet, setTailnet] = useState<TailnetStatus>({ kind: "idle" });
  const [peers, setPeers] = useState<PeerDevice[]>([]);
  const [peersError, setPeersError] = useState<string | null>(null);
  const [selectedPeer, setSelectedPeer] = useState<PeerDevice | null>(null);
  const [host, setHost] = useState("");
  const [port, setPort] = useState("5900");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  // Pending Tailscale browser sign-in (interactive login). Opened once per
  // URL automatically; the card keeps a button to reopen it.
  const [signInUrl, setSignInUrl] = useState<string | null>(null);
  const openedSignInUrlRef = useRef<string | null>(null);
  const [hostError, setHostError] = useState<string | null>(null);
  const portRef = useRef<TextInput>(null);
  const passwordRef = useRef<TextInput>(null);
  const [portError, setPortError] = useState<string | null>(null);
  // macOS Screen Sharing needs a username; other VNC servers don't, so the
  // field stays folded until someone asks for it (or a saved connection had one).
  const [showMacUser, setShowMacUser] = useState(false);

  // Prefill the last manual connection (no password) once on mount.
  useEffect(() => {
    let cancelled = false;
    void loadLastManualConnection().then((last) => {
      if (cancelled || !last) return;
      setHost((current) => current || last.host);
      setPort((current) => (current === "" || current === "5900" ? last.port : current));
      setUsername((current) => current || last.username || "");
      if (last.username) setShowMacUser(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function openSignIn(url: string, force = false): void {
    if (!isWebUrl(url) || (!force && openedSignInUrlRef.current === url)) return;
    openedSignInUrlRef.current = url;
    Linking.openURL(url).catch(() => {
      setStatus("Couldn't open the browser. Tap Open Tailscale Sign-In to retry.");
    });
  }

  async function loadPeers(): Promise<void> {
    try {
      const peerList = await NomadNativeModule.getTailnetPeers();
      setPeers(peerList);
      setPeersError(null);
    } catch (err) {
      setPeersError(err instanceof Error ? err.message : "Failed to load peers");
    }
  }

  // Local-first: Tailnet only starts when the user explicitly enables it.
  // Manual host/IP connections work without any account or Tailnet.
  // Resolves true when the tailnet is ready to use.
  async function ensureTailnet(): Promise<boolean> {
    if (tailnet.kind === "ready") return true;
    if (tailnet.kind === "starting") return false;
    setTailnet({ kind: "starting" });
    setStatus("Starting Tailscale…");
    try {
      const saved = await loadMobileSettings();
      await NomadNativeModule.setTailscaleHostname(saved.tailscaleHostname);
      const state = await NomadNativeModule.ensureTailnetReady();
      setTailnet({ kind: "ready", state });
      if (state.loggedIn) {
        setStatus(null);
        await loadPeers();
      } else {
        setStatus("Finish signing in to Tailscale in your browser");
        const url = signInUrlFor(state);
        if (url) {
          setSignInUrl(url);
          openSignIn(url);
        }
      }
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Couldn't start Tailscale";
      setTailnet({ kind: "error", message });
      setStatus(message);
      return false;
    }
  }

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    try {
      unsubscribe = NomadNativeModule.subscribe((event) => {
        if (event.type === "error") {
          setStatus(event.message ?? "Unexpected error");
        } else if (event.type === "authUrl" && event.authUrl && isWebUrl(event.authUrl)) {
          setSignInUrl(event.authUrl);
          openSignIn(event.authUrl);
        }
      });
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Native module unavailable");
    }
    return () => {
      unsubscribe?.();
    };
  }, []);

  // While a browser sign-in is pending, re-read the tailnet state until the
  // node comes up, then load peers — the user returns from the browser to
  // a populated list without having to tap anything.
  const awaitingLogin = tailnet.kind === "ready" && !tailnet.state.loggedIn;
  useEffect(() => {
    if (!awaitingLogin) return;
    let cancelled = false;
    const timer = setInterval(() => {
      NomadNativeModule.getTailnetState()
        .then(async (state) => {
          if (cancelled) return;
          if (state.loggedIn) {
            setTailnet({ kind: "ready", state });
            setSignInUrl(null);
            setStatus(null);
            await loadPeers();
          } else {
            const url = signInUrlFor(state);
            if (url) setSignInUrl(url);
          }
        })
        .catch(() => {
          // Transient; the next tick retries.
        });
    }, SIGN_IN_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [awaitingLogin]);

  function validateHost(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return null; // Optional when using a peer
    // Basic hostname/IP validation
    if (trimmed.length > 253) return "Host name too long";
    if (!/^[a-zA-Z0-9._-]+$/.test(trimmed)) return "Invalid host name";
    return null;
  }

  function validatePort(value: string): string | null {
    const trimmed = value.trim();
    if (!trimmed) return "Port is required";
    const num = Number(trimmed);
    if (!Number.isInteger(num) || num < 1 || num > 65535) {
      return "Port must be 1–65535";
    }
    return null;
  }

  async function handleConnect(): Promise<void> {
    if (connecting) return;

    // Inline validation
    const hErr = validateHost(host);
    const pErr = validatePort(port);
    setHostError(hErr);
    setPortError(pErr);
    if (hErr || pErr) {
      setStatus("Fix the highlighted fields");
      return;
    }
    if (!selectedPeer && !host.trim()) {
      setStatus("Enter an address or pick a device from your tailnet");
      setHostError("Required");
      return;
    }

    const built = buildConnectInput(
      { peer: selectedPeer, host: host.trim(), port: Number(port) },
      // Empty: the Go engine mints a random proxy token. It guards a
      // loopback port any app on the device can reach, so it must never be
      // guessable (this used to be Date.now()).
      "",
    );
    if (!built.ok) {
      setStatus(built.error);
      return;
    }

    setConnecting(true);
    setStatus("Connecting…");
    try {
      const session = await NomadNativeModule.startVncSession(built.input);
      const assetBaseUrl = await NomadNativeModule.getViewerAssetBaseUrl();
      if (!selectedPeer && host.trim()) {
        void saveLastManualConnection({ host: host.trim(), port, username: username.trim() || undefined });
      }
      onConnect({
        sessionId: session.sessionId,
        wsUrl: session.wsUrl,
        password,
        assetBaseUrl,
        username: username.trim() || undefined,
        host: built.input.host,
        direct: built.input.direct ?? false,
        label: selectedPeer?.displayName ?? host.trim(),
      });
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Connect failed");
    } finally {
      setConnecting(false);
    }
  }

  async function handleRefreshPeers(): Promise<void> {
    if (tailnet.kind !== "ready") return;
    setPeersError(null);
    try {
      const peerList = await NomadNativeModule.getTailnetPeers();
      setPeers(peerList);
    } catch (err) {
      setPeersError(err instanceof Error ? err.message : "Failed to refresh");
    }
  }

  const styles = makeStyles(theme);

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 20}
      >
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.titleRow}>
            <Text style={styles.title}>NomadVNC</Text>
            <Pressable
              onPress={onSettings}
              style={styles.settingsButton}
              accessibilityRole="button"
              accessibilityLabel="Open settings"
              hitSlop={8}
            >
              <SettingsIcon color={theme.text} />
            </Pressable>
          </View>
          {!signedIn && (
            <Text style={styles.subtitle}>
              Connect to computers on your network. No account needed.{"\n"}
              Sign in with Tailscale to reach them from anywhere.
            </Text>
          )}

          {/* Saved devices — only visible content when signed in; logged-out
              users see a subtle sign-in row and the same screen as before. */}
          <SavedDevicesSection
            theme={theme}
            onConnect={onConnect}
            onLogin={onLogin}
            ensureTailnet={ensureTailnet}
          />

          {/* Manual connection — works without Tailnet */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Manual Connection</Text>
            <View style={styles.field}>
            <Text
              style={styles.label}
              nativeID="hostLabel"
            >
              Host or IP Address
            </Text>
            <TextInput
              value={host}
              onChangeText={(v) => {
                setHost(v);
                if (hostError) setHostError(validateHost(v));
              }}
              placeholder="192.168.1.10 or my-mac.local"
              placeholderTextColor={theme.placeholder}
              style={[styles.input, hostError && styles.inputError]}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabelledBy="hostLabel"
              accessibilityHint="Enter the VNC server host name or IP address"
              returnKeyType="next"
              blurOnSubmit={false}
              onSubmitEditing={() => portRef.current?.focus()}
            />
            </View>
            {hostError && (
              <Text style={styles.fieldError} role="alert">
                {hostError}
              </Text>
            )}

            <View style={styles.field}>
            <Text style={styles.label} nativeID="portLabel">
              VNC Port
            </Text>
            <TextInput
              ref={portRef}
              value={port}
              onChangeText={(v) => {
                setPort(v);
                if (portError) setPortError(validatePort(v));
              }}
              placeholder="5900"
              placeholderTextColor={theme.placeholder}
              style={[styles.input, portError && styles.inputError]}
              keyboardType="numeric"
              accessibilityLabelledBy="portLabel"
              accessibilityHint="VNC server port, usually 5900"
              returnKeyType="next"
              blurOnSubmit={false}
              onSubmitEditing={() => passwordRef.current?.focus()}
            />
            </View>
            {portError && (
              <Text style={styles.fieldError} role="alert">
                {portError}
              </Text>
            )}

            <View style={styles.field}>
            <Text style={styles.label} nativeID="passLabel">
              VNC Password
            </Text>
            <TextInput
              ref={passwordRef}
              value={password}
              onChangeText={setPassword}
              placeholder="VNC password"
              placeholderTextColor={theme.placeholder}
              style={styles.input}
              secureTextEntry
              accessibilityLabelledBy="passLabel"
              accessibilityHint="Password for the VNC server"
              returnKeyType="done"
              onSubmitEditing={() => void handleConnect()}
            />
            </View>

            <Pressable
              onPress={() => setShowMacUser((open) => !open)}
              accessibilityRole="button"
              accessibilityLabel="macOS Screen Sharing username"
              accessibilityState={{ expanded: showMacUser }}
            >
              <Text style={styles.link}>
                {showMacUser ? "Hide macOS Username" : "macOS Screen Sharing"}
              </Text>
            </Pressable>
            {showMacUser && (
              <>
                <View style={styles.field}>
                <Text style={styles.label} nativeID="userLabel">
                  Username <Text style={styles.optional}>(Mac account short name)</Text>
                </Text>
                <TextInput
                  value={username}
                  onChangeText={setUsername}
                  placeholder="Mac account short name"
                  placeholderTextColor={theme.placeholder}
                  style={styles.input}
                  autoCapitalize="none"
                  autoCorrect={false}
                  accessibilityLabelledBy="userLabel"
                  accessibilityHint="Optional: your Mac user account name for Screen Sharing"
                  returnKeyType="done"
                  onSubmitEditing={() => void handleConnect()}
                />
                </View>
              </>
            )}
          </View>

          {/* Tailnet — opt-in */}
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Your Tailnet</Text>
            {tailnet.kind === "idle" && (
              <>
                <Text style={styles.muted}>
                  Tailscale lists the computers you can reach and connects to them securely from anywhere, with no port forwarding.
                </Text>
                <Pressable
                  onPress={() => void ensureTailnet()}
                  style={styles.secondaryButton}
                  accessibilityRole="button"
                  accessibilityLabel="Sign in with Tailscale"
                >
                  <Text style={styles.secondaryLabel}>Sign In with Tailscale</Text>
                </Pressable>
              </>
            )}
            {tailnet.kind === "starting" && (
              <Text style={styles.muted}>Starting Tailscale…</Text>
            )}
            {tailnet.kind === "error" && (
              <>
                <Text style={styles.fieldError}>{tailnet.message}</Text>
                <Pressable
                  onPress={() => void ensureTailnet()}
                  style={styles.secondaryButton}
                  accessibilityRole="button"
                  accessibilityLabel="Retry Tailscale"
                >
                  <Text style={styles.secondaryLabel}>Retry</Text>
                </Pressable>
              </>
            )}
            {tailnet.kind === "ready" && !tailnet.state.loggedIn && (
              <>
                <Text style={styles.muted}>
                  Finish signing in to Tailscale in your browser, then come
                  back. Your devices appear here automatically.
                </Text>
                {signInUrl && (
                  <Pressable
                    onPress={() => openSignIn(signInUrl, true)}
                    style={styles.secondaryButton}
                    accessibilityRole="button"
                    accessibilityLabel="Open Tailscale sign-in"
                  >
                    <Text style={styles.secondaryLabel}>Open Tailscale Sign-In</Text>
                  </Pressable>
                )}
              </>
            )}
            {tailnet.kind === "ready" && tailnet.state.loggedIn && (
              <>
                <View style={styles.row}>
                  <View style={styles.field}>
                    <Text style={styles.muted}>
                      {tailnet.state.selfDeviceName ?? "Connected to your tailnet"}
                    </Text>
                    <Text style={styles.hint}>Change this name in Settings.</Text>
                  </View>
                  <Pressable
                    onPress={() => void handleRefreshPeers()}
                    accessibilityRole="button"
                    accessibilityLabel="Refresh device list"
                  >
                    <Text style={styles.link}>Refresh</Text>
                  </Pressable>
                </View>
                {peersError ? (
                  <Text style={styles.fieldError}>{peersError}</Text>
                ) : peers.length === 0 ? (
                  <Text style={styles.muted}>
                    No devices found. Make sure your other devices are online
                    and signed in to the same tailnet.
                  </Text>
                ) : (
                  peers.map((peer) => (
                    <Pressable
                      key={peer.stableId}
                      onPress={() => setSelectedPeer(peer)}
                      style={[
                        styles.peer,
                        selectedPeer?.stableId === peer.stableId &&
                          styles.peerActive,
                      ]}
                      accessibilityRole="radio"
                      accessibilityState={{
                        selected: selectedPeer?.stableId === peer.stableId,
                      }}
                      accessibilityLabel={`${peer.displayName}, ${
                        peer.online ? "online" : "offline"
                      }`}
                    >
                      <Text style={styles.peerTitle}>{peer.displayName}</Text>
                      <Text style={styles.peerMeta}>
                        {peer.online ? "Online" : "Offline"}
                        {" · "}
                        {peer.dnsName ?? peer.tailnetIps[0]}
                      </Text>
                    </Pressable>
                  ))
                )}
              </>
            )}
          </View>
        </ScrollView>
        {(!signedIn || host.trim() !== "" || selectedPeer !== null || connecting) && (
          <View style={[styles.footer, { paddingBottom: 12 + insets.bottom }]}>
            {status && (
              <Text style={styles.status} role="status">
                {status}
              </Text>
            )}
            <Pressable
              onPress={() => void handleConnect()}
              style={[styles.button, connecting && styles.buttonDisabled]}
              disabled={connecting}
              accessibilityRole="button"
              accessibilityLabel={connecting ? "Connecting" : "Connect to VNC server"}
              accessibilityState={{ disabled: connecting, busy: connecting }}
            >
              <Text style={styles.buttonLabel}>
                {connecting ? "Connecting…" : "Connect"}
              </Text>
            </Pressable>
          </View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export interface Theme {
  bg: string;
  card: string;
  input: string;
  text: string;
  muted: string;
  placeholder: string;
  accent: string;
  accentText: string;
  error: string;
  border: string;
  toolbar: string;
}

export const darkTheme: Theme = {
  bg: "#080C12",
  card: "#161D2A",
  input: "#0E141E",
  text: "#F4F7FB",
  muted: "#9AABC4",
  placeholder: "#7E90AA",
  accent: "#3C8DFF",
  accentText: "#FFFFFF",
  error: "#FF8A8A",
  border: "#2C384C",
  toolbar: "#121924",
};

export const lightTheme: Theme = {
  bg: "#F2F4F8",
  card: "#FFFFFF",
  input: "#F4F6FA",
  text: "#0E1A2B",
  muted: "#5B6B85",
  placeholder: "#8A9BB5",
  accent: "#0A6CFF",
  accentText: "#FFFFFF",
  error: "#C81E1E",
  border: "#E2E8F0",
  toolbar: "#FFFFFF",
};

/** Soft lift so cards read as surfaces on the canvas, in both themes. */
/** Phone screens stay full width. iPad forms stay a readable column. */
export const CONTENT_MAX_WIDTH = 640;

export function cardElevation(theme: Theme) {
  const dark = theme.bg === darkTheme.bg;
  return Platform.select({
    ios: {
      shadowColor: "#000",
      shadowOpacity: dark ? 0.35 : 0.08,
      shadowRadius: dark ? 18 : 12,
      shadowOffset: { width: 0, height: 8 },
    },
    android: { elevation: dark ? 6 : 3 },
  });
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    flex: { flex: 1 },
    safe: {
      flex: 1,
      backgroundColor: theme.bg,
    },
    content: {
      paddingHorizontal: 24,
      paddingTop: 12,
      paddingBottom: 20,
      gap: 20,
      width: "100%",
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: "center",
    },
    footer: {
      paddingHorizontal: 20,
      paddingTop: 12,
      gap: 8,
      backgroundColor: theme.card,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    title: {
      color: theme.text,
      fontSize: 28,
      fontWeight: "700",
    },
    titleRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    settingsButton: {
      width: 40,
      height: 40,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.card,
      borderWidth: 1,
      borderColor: theme.border,
    },
    subtitle: {
      color: theme.muted,
      lineHeight: 22,
    },
    card: {
      borderRadius: 20,
      padding: 24,
      backgroundColor: theme.card,
      borderWidth: 1,
      borderColor: theme.border,
      gap: 20,
      ...cardElevation(theme),
    },
    field: {
      gap: 8,
    },
    cardTitle: {
      color: theme.text,
      fontSize: 15,
      fontWeight: "700",
      paddingBottom: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    label: {
      color: theme.muted,
      fontSize: 13,
      fontWeight: "600",
    },
    hint: {
      color: theme.placeholder,
      fontSize: 13,
      lineHeight: 18,
    },
    optional: {
      color: theme.muted,
      fontWeight: "400",
    },
    input: {
      borderRadius: 12,
      paddingHorizontal: 16,
      paddingVertical: 14,
      backgroundColor: theme.input,
      color: theme.text,
      fontSize: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    inputError: {
      borderWidth: 1,
      borderColor: theme.error,
    },
    fieldError: {
      color: theme.error,
      fontSize: 13,
    },
    button: {
      borderRadius: 14,
      paddingVertical: 14,
      alignItems: "center",
      backgroundColor: theme.accent,
      ...Platform.select({
        ios: {
          shadowColor: "#000",
          shadowOpacity: 0.18,
          shadowRadius: 8,
          shadowOffset: { width: 0, height: 4 },
        },
        android: { elevation: 3 },
      }),
    },
    buttonDisabled: {
      opacity: 0.6,
    },
    buttonLabel: {
      color: theme.accentText,
      fontWeight: "700",
      fontSize: 16,
    },
    secondaryButton: {
      borderRadius: 14,
      paddingVertical: 12,
      alignItems: "center",
      backgroundColor: theme.input,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    secondaryLabel: {
      color: theme.text,
      fontWeight: "600",
      fontSize: 15,
    },
    status: {
      color: theme.muted,
      fontSize: 14,
    },
    muted: {
      color: theme.muted,
      fontSize: 14,
      lineHeight: 20,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    link: {
      color: theme.accent,
      fontWeight: "600",
    },
    peer: {
      padding: 14,
      borderRadius: 16,
      backgroundColor: theme.input,
    },
    peerActive: {
      borderWidth: 1.5,
      borderColor: theme.accent,
    },
    peerTitle: {
      color: theme.text,
      fontSize: 16,
      fontWeight: "600",
    },
    peerMeta: {
      color: theme.muted,
      marginTop: 4,
      fontSize: 13,
    },
  });
}
