import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useAccount } from "../account/AccountContext";
import {
  buildSavedDeviceInput,
  groupDevicesByCollection,
  savedDeviceHost,
  type SavedDeviceLike,
} from "../account/deviceUi";
import {
  deviceIdentityForAddress,
  loadLocalDevices,
  newLocalDeviceId,
  saveLocalDevices,
  setLocalCredentialFlag,
  upsertLocalDevice,
  type LocalDevice,
} from "../account/localDevices";
import { NomadNativeModule } from "../native/NomadNativeModule";
import type { PeerDevice } from "@nomadvnc/platform-contracts";
import { cardElevation, type MobileSession, type Theme } from "../screens/HomeScreen";
import { ShareDialog } from "./ShareDialog";
import { loadMobileSettings } from "../settings";
import { getDevicePresence, presenceColor, presenceLabel, type DevicePresence } from "../presence";

interface SavedDevicesSectionProps {
  theme: Theme;
  onConnect: (payload: MobileSession) => void;
  onLogin: () => void;
  /** Starts Tailnet if needed; resolves true when it's ready. */
  ensureTailnet: () => Promise<boolean>;
}

/**
 * "My Devices". Signed in, the list is the account's synced devices (tap →
 * fetch the encrypted VNC password from the backend → connect). Signed
 * out, it is the local list on this phone (passwords in the OS keychain),
 * so local mode can save machines too. Devices without a stored password
 * get an inline prompt.
 */
export function SavedDevicesSection({
  theme,
  onConnect,
  onLogin,
  ensureTailnet,
}: SavedDevicesSectionProps) {
  const account = useAccount();
  const styles = makeStyles(theme);

  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [passwordPromptId, setPasswordPromptId] = useState<string | null>(null);
  const [promptPassword, setPromptPassword] = useState("");
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [sectionError, setSectionError] = useState<string | null>(null);
  const [sectionNotice, setSectionNotice] = useState<string | null>(null);
  const [sharingDevice, setSharingDevice] = useState<SavedDeviceLike | null>(null);
  const [showAddForm, setShowAddForm] = useState(false);

  // Add-device form fields.
  const [newLabel, setNewLabel] = useState("");
  const [newHost, setNewHost] = useState("");
  const [newPort, setNewPort] = useState("5900");

  // Prefill the add-device port from Settings (desktop parity).
  useEffect(() => {
    void loadMobileSettings().then((s) => {
      setNewPort((prev) => (prev === "5900" ? String(s.defaultVncPort) : prev));
    });
  }, []);
  // Presence: fetch tailnet peers when signed in so saved-device rows can
  // show online/offline dots (desktop parity).
  const [peers, setPeers] = useState<PeerDevice[]>([]);
  const signedIn = account.session !== null;
  useEffect(() => {
    if (!signedIn) {
      setPeers([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const ready = await ensureTailnet();
        if (!ready || cancelled) return;
        const list = await NomadNativeModule.getTailnetPeers();
        if (!cancelled) setPeers(list);
      } catch {
        if (!cancelled) setPeers([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [signedIn]);
  const [newCollection, setNewCollection] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [saving, setSaving] = useState(false);

  // Local mode: devices saved on this phone only.
  const [localDevices, setLocalDevices] = useState<LocalDevice[]>([]);
  useEffect(() => {
    if (signedIn) return;
    let cancelled = false;
    void loadLocalDevices().then((list) => {
      if (!cancelled) setLocalDevices(list);
    });
    return () => {
      cancelled = true;
    };
  }, [signedIn]);

  async function persistLocal(next: LocalDevice[]): Promise<void> {
    setLocalDevices(next);
    await saveLocalDevices(next);
  }

  async function connectDevice(device: SavedDeviceLike, password: string): Promise<void> {
    // Empty: the Go engine mints a random proxy token (see HomeScreen).
    const built = buildSavedDeviceInput(device, "");
    if (!built.ok) {
      setSectionError(built.error);
      return;
    }
    if (!built.input.direct) {
      // Tailnet-only target — the sidecar fails clearly without login, so
      // make sure Tailnet is up first for a smoother error path.
      const ready = await ensureTailnet();
      if (!ready) {
        setSectionError("This device is on your tailnet. Sign in with Tailscale below to reach it.");
        return;
      }
    }
    const session = await NomadNativeModule.startVncSession(built.input);
    const assetBaseUrl = await NomadNativeModule.getViewerAssetBaseUrl();
    onConnect({
      sessionId: session.sessionId,
      wsUrl: session.wsUrl,
      password,
      assetBaseUrl,
      deviceId: device.id,
      host: built.input.host,
      label: device.label,
    });
  }

  async function handleTap(device: SavedDeviceLike): Promise<void> {
    if (connectingId || passwordPromptId) return;
    setConnectingId(device.id);
    setSectionError(null);
    try {
      const stored = signedIn
        ? await account.client.getDeviceCredential(device.id)
        : await NomadNativeModule.getMachinePassword(device.id).catch(() => null);
      if (stored == null) {
        setPasswordPromptId(device.id);
        setPromptPassword("");
      } else {
        await connectDevice(device, stored);
      }
    } catch (err) {
      setSectionError(err instanceof Error ? err.message : "Connect failed");
    } finally {
      setConnectingId(null);
    }
  }

  async function handlePromptGo(device: SavedDeviceLike): Promise<void> {
    setPasswordPromptId(null);
    setConnectingId(device.id);
    try {
      await connectDevice(device, promptPassword);
    } catch (err) {
      setSectionError(err instanceof Error ? err.message : "Connect failed");
    } finally {
      setConnectingId(null);
      setPromptPassword("");
    }
  }

  function handleNotice(message: string, variant: "info" | "success" | "error"): void {
    if (variant === "error") {
      setSectionError(message);
      setSectionNotice(null);
    } else {
      setSectionNotice(message);
      setSectionError(null);
    }
  }

  async function handleDelete(deviceId: string): Promise<void> {
    if (pendingDeleteId !== deviceId) {
      setPendingDeleteId(deviceId);
      return;
    }
    setPendingDeleteId(null);
    setSectionError(null);
    try {
      if (signedIn) {
        await account.client.deleteDevice(deviceId);
        await account.refreshDevices();
      } else {
        await NomadNativeModule.deleteMachinePassword(deviceId).catch(() => {});
        await persistLocal(localDevices.filter((d) => d.id !== deviceId));
      }
    } catch (err) {
      setSectionError(err instanceof Error ? err.message : "Couldn't remove the device");
    }
  }

  async function handleAddDevice(): Promise<void> {
    const label = newLabel.trim();
    const host = newHost.trim();
    const port = Number(newPort.trim());
    if (!label) {
      setSectionError("Give the device a label first");
      return;
    }
    if (!host) {
      setSectionError("Enter the device's address");
      return;
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setSectionError("Port must be 1–65535");
      return;
    }
    setSaving(true);
    setSectionError(null);
    try {
      if (signedIn) {
        const device = await account.client.upsertDevice({
          label,
          // Same identity rule as desktop: LAN hosts are manual:<host>,
          // tailnet names stay as-is so they keep routing via the tailnet.
          tailscaleStableId: deviceIdentityForAddress(host),
          dnsName: host,
          lastKnownIp: /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host : undefined,
          vncPort: port,
          collectionName: newCollection.trim() || undefined,
        });
        if (newPassword) {
          await account.client.setDeviceCredential(device.id, newPassword);
        }
        await account.refreshDevices();
      } else {
        const result = upsertLocalDevice(
          localDevices,
          { label, host, port, collectionName: newCollection },
          newLocalDeviceId,
        );
        let next = result.devices;
        if (newPassword) {
          await NomadNativeModule.setMachinePassword(result.device.id, newPassword);
          next = setLocalCredentialFlag(next, result.device.id, true);
        }
        await persistLocal(next);
      }
      setNewLabel("");
      setNewHost("");
      setNewPort("5900");
      setNewCollection("");
      setNewPassword("");
      setShowAddForm(false);
    } catch (err) {
      setSectionError(err instanceof Error ? err.message : "Couldn't save the device");
    } finally {
      setSaving(false);
    }
  }

  if (account.loading) {
    return (
      <View style={styles.card}>
        <Text style={styles.muted}>Checking account…</Text>
      </View>
    );
  }

  const groups = groupDevicesByCollection(signedIn ? account.devices : localDevices);
  const sharedDevices = signedIn ? account.sharedDevices : [];

  return (
    <View style={styles.card}>
      <View style={styles.header}>
        <View style={styles.row}>
          <Text style={styles.headerTitle}>{signedIn ? "Computers" : "My Devices"}</Text>
          {signedIn ? (
            <Pressable
              onPress={() => void account.logout()}
              accessibilityRole="button"
              accessibilityLabel="Sign out"
            >
              <Text style={styles.link}>Sign Out</Text>
            </Pressable>
          ) : (
            <Pressable onPress={onLogin} accessibilityRole="button" accessibilityLabel="Sign in to sync devices">
              <Text style={styles.link}>Sign In to Sync</Text>
            </Pressable>
          )}
        </View>
        <Text style={styles.muted} numberOfLines={1}>
          {signedIn ? account.email : "Saved on This Phone"}
        </Text>
      </View>

      {(account.error || sectionError || sectionNotice) && (
        <View>
          <Text
            style={sectionNotice ? styles.noticeText : styles.fieldError}
            role="alert"
          >
            {sectionNotice ?? sectionError ?? account.error}
          </Text>
          <Pressable
            onPress={() => {
              setSectionError(null);
              setSectionNotice(null);
              void account.refreshDevices();
            }}
            accessibilityRole="button"
            accessibilityLabel="Retry loading devices"
          >
            <Text style={styles.link}>Retry</Text>
          </Pressable>
        </View>
      )}

      {groups.length === 0 && sharedDevices.length === 0 ? (
        <Text style={styles.muted}>
          {signedIn
            ? "No computers yet. Add the ones you connect to most and they'll sync to your other devices."
            : "No saved devices yet. Save the machines you connect to most for one-tap connections."}
        </Text>
      ) : (
        groups.map((group) => (
          <View key={group.name} style={styles.group}>
            {/* A lone "Ungrouped" header says nothing; show names once groups exist. */}
            {(groups.length > 1 || group.name !== "Ungrouped") && (
              <Text style={styles.groupTitle}>{group.name}</Text>
            )}
            {group.devices.map((device) => (
              <DeviceRow
                key={device.id}
                styles={styles}
                theme={theme}
                device={device}
                presence={getDevicePresence(device, peers)}
                connecting={connectingId === device.id}
                confirmDelete={pendingDeleteId === device.id}
                onTap={() => void handleTap(device)}
                onDelete={() => void handleDelete(device.id)}
                onShare={
                  signedIn
                    ? () => {
                        setSectionError(null);
                        setSectionNotice(null);
                        setSharingDevice(device);
                      }
                    : undefined
                }
                passwordPrompt={
                  passwordPromptId === device.id ? (
                    <View style={styles.promptBox}>
                      <Text style={styles.muted}>
                        No saved password. Enter it to connect.
                      </Text>
                      <View style={styles.inlineRow}>
                        <TextInput
                          value={promptPassword}
                          onChangeText={setPromptPassword}
                          placeholder="VNC password"
                          placeholderTextColor={theme.placeholder}
                          style={[styles.input, styles.flexGrow]}
                          secureTextEntry
                          accessibilityLabel={`VNC password for ${device.label}`}
                          returnKeyType="go"
                          onSubmitEditing={() => void handlePromptGo(device)}
                        />
                        <Pressable
                          onPress={() => void handlePromptGo(device)}
                          style={styles.smallButton}
                          accessibilityRole="button"
                          accessibilityLabel={`Connect to ${device.label}`}
                        >
                          <Text style={styles.smallButtonLabel}>Go</Text>
                        </Pressable>
                        <Pressable
                          onPress={() => {
                            setPasswordPromptId(null);
                            setPromptPassword("");
                          }}
                          accessibilityRole="button"
                          accessibilityLabel="Cancel"
                        >
                          <Text style={styles.link}>Cancel</Text>
                        </Pressable>
                      </View>
                    </View>
                  ) : null
                }
              />
            ))}
          </View>
        ))
      )}

      {sharedDevices.length > 0 && (
        <View style={styles.group}>
          <Text style={styles.groupTitle}>Shared With Me</Text>
          {sharedDevices.map((device) => (
            <DeviceRow
              key={device.id}
              styles={styles}
              theme={theme}
              device={device}
              presence={getDevicePresence(device, peers)}
              sharedBy={device.sharedBy}
              connecting={connectingId === device.id}
              onTap={() => void handleTap(device)}
              passwordPrompt={
                passwordPromptId === device.id ? (
                  <View style={styles.promptBox}>
                    <Text style={styles.muted}>
                      No saved password. Enter it to connect.
                    </Text>
                    <View style={styles.inlineRow}>
                      <TextInput
                        value={promptPassword}
                        onChangeText={setPromptPassword}
                        placeholder="VNC password"
                        placeholderTextColor={theme.placeholder}
                        style={[styles.input, styles.flexGrow]}
                        secureTextEntry
                        accessibilityLabel={`VNC password for ${device.label}`}
                        returnKeyType="go"
                        onSubmitEditing={() => void handlePromptGo(device)}
                      />
                      <Pressable
                        onPress={() => void handlePromptGo(device)}
                        style={styles.smallButton}
                        accessibilityRole="button"
                        accessibilityLabel={`Connect to ${device.label}`}
                      >
                        <Text style={styles.smallButtonLabel}>Go</Text>
                      </Pressable>
                      <Pressable
                        onPress={() => {
                          setPasswordPromptId(null);
                          setPromptPassword("");
                        }}
                        accessibilityRole="button"
                        accessibilityLabel="Cancel"
                      >
                        <Text style={styles.link}>Cancel</Text>
                      </Pressable>
                    </View>
                  </View>
                ) : null
              }
            />
          ))}
        </View>
      )}

      {/* Add device */}
      {showAddForm ? (
        <View style={styles.group}>
          <Text style={styles.groupTitle}>Add Device</Text>
          <Text style={styles.label}>Label</Text>
          <TextInput
            value={newLabel}
            onChangeText={setNewLabel}
            placeholder="Office PC"
            placeholderTextColor={theme.placeholder}
            style={styles.input}
            accessibilityLabel="Device label"
          />
          <Text style={styles.label}>Address (IP, Hostname, or Tailnet Name)</Text>
          <TextInput
            value={newHost}
            onChangeText={setNewHost}
            placeholder="192.168.1.10 or office-pc.tail1234.ts.net"
            placeholderTextColor={theme.placeholder}
            style={styles.input}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Device host"
          />
          <Text style={styles.label}>VNC Port</Text>
          <TextInput
            value={newPort}
            onChangeText={setNewPort}
            placeholder="5900"
            placeholderTextColor={theme.placeholder}
            style={styles.input}
            keyboardType="numeric"
            accessibilityLabel="Device VNC port"
          />
          <Text style={styles.label}>
            Collection <Text style={styles.optional}>(optional)</Text>
          </Text>
          <TextInput
            value={newCollection}
            onChangeText={setNewCollection}
            placeholder="Work"
            placeholderTextColor={theme.placeholder}
            style={styles.input}
            accessibilityLabel="Device collection, optional"
          />
          <Text style={styles.label}>
            VNC Password{" "}
            <Text style={styles.optional}>
              {signedIn ? "(optional, synced encrypted)" : "(optional, saved in this phone's keychain)"}
            </Text>
          </Text>
          <TextInput
            value={newPassword}
            onChangeText={setNewPassword}
            placeholder="VNC password"
            placeholderTextColor={theme.placeholder}
            style={styles.input}
            secureTextEntry
            accessibilityLabel="Device VNC password, optional"
            returnKeyType="done"
            onSubmitEditing={() => void handleAddDevice()}
          />
          <View style={styles.inlineRow}>
            <Pressable
              onPress={() => void handleAddDevice()}
              disabled={saving}
              style={[styles.smallButton, saving && styles.buttonDisabled]}
              accessibilityRole="button"
              accessibilityLabel="Save device"
            >
              <Text style={styles.smallButtonLabel}>{saving ? "Saving…" : "Save Device"}</Text>
            </Pressable>
            <Pressable
              onPress={() => {
                setShowAddForm(false);
                setSectionError(null);
              }}
              accessibilityRole="button"
              accessibilityLabel="Cancel adding device"
            >
              <Text style={styles.link}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      ) : (
        <Pressable
          onPress={() => setShowAddForm(true)}
          style={styles.secondaryButton}
          accessibilityRole="button"
          accessibilityLabel="Add a device"
        >
          <Text style={styles.secondaryLabel}>Add Device</Text>
        </Pressable>
      )}
      {/* Share dialog */}
      {sharingDevice && (
        <ShareDialog
          visible
          theme={theme}
          deviceId={sharingDevice.id}
          deviceLabel={sharingDevice.label}
          onClose={() => setSharingDevice(null)}
          onNotice={handleNotice}
        />
      )}
    </View>
  );
}

function DeviceRow({
  styles,
  theme,
  device,
  presence,
  sharedBy,
  connecting,
  confirmDelete,
  onTap,
  onDelete,
  onShare,
  passwordPrompt,
}: {
  styles: ReturnType<typeof makeStyles>;
  theme: Theme;
  device: SavedDeviceLike & { hasCredential?: boolean };
  presence: DevicePresence;
  sharedBy?: string;
  connecting: boolean;
  confirmDelete?: boolean;
  onTap: () => void;
  onDelete?: () => void;
  onShare?: () => void;
  passwordPrompt: React.ReactNode;
}) {
  const host = savedDeviceHost(device) || "No Address";
  return (
    <View>
      <Pressable
        onPress={onTap}
        style={styles.deviceRow}
        accessibilityRole="button"
        accessibilityLabel={`Connect to ${device.label}`}
        accessibilityHint={`${host}, port ${device.vncPort}`}
      >
        <View style={styles.deviceMain}>
          <View style={styles.deviceTitleRow}>
            {presence.kind !== "direct" && (
              <View
                accessible
                accessibilityLabel={presenceLabel(presence.kind)}
                style={[
                  styles.presenceDot,
                  { backgroundColor: presenceColor(presence.kind, theme.muted) },
                ]}
              />
            )}
            <Text style={styles.deviceTitle} numberOfLines={1}>
              {device.label}
            </Text>
          </View>
          {sharedBy ? <Text style={styles.sharedBadge}>Shared by {sharedBy}</Text> : null}
          <Text style={styles.deviceHost} numberOfLines={2}>
            {host}
          </Text>
          <Text style={styles.deviceMeta}>
            {`Port ${device.vncPort}`}
            {device.hasCredential ? " · Password saved" : ""}
            {connecting ? " · Connecting…" : ""}
          </Text>
        </View>
        {(onShare || onDelete) && (
          <View style={styles.deviceActions}>
            {onShare && (
              <Pressable
                onPress={onShare}
                accessibilityRole="button"
                accessibilityLabel={`Share ${device.label}`}
                hitSlop={8}
              >
                <Text style={styles.shareAction}>Share</Text>
              </Pressable>
            )}
            {onDelete && (
              <Pressable
                onPress={onDelete}
                accessibilityRole="button"
                accessibilityLabel={
                  confirmDelete ? `Confirm remove ${device.label}` : `Remove ${device.label}`
                }
                hitSlop={8}
              >
                <Text style={confirmDelete ? styles.deleteConfirm : styles.delete}>
                  {confirmDelete ? "Confirm" : "Remove"}
                </Text>
              </Pressable>
            )}
          </View>
        )}
      </Pressable>
      {passwordPrompt}
    </View>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    card: {
      borderRadius: 20,
      padding: 24,
      backgroundColor: theme.card,
      borderWidth: 1,
      borderColor: theme.border,
      gap: 16,
      ...cardElevation(theme),
    },
    signInRow: {
      borderRadius: 20,
      padding: 20,
      backgroundColor: theme.card,
      borderWidth: 1,
      borderColor: theme.border,
      ...cardElevation(theme),
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    signInText: {
      color: theme.muted,
      fontSize: 14,
    },
    header: {
      gap: 4,
      paddingBottom: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    headerTitle: {
      color: theme.text,
      fontSize: 20,
      fontWeight: "700",
    },
    group: {
      gap: 8,
    },
    groupTitle: {
      color: theme.muted,
      fontSize: 13,
      fontWeight: "600",
    },
    deviceRow: {
      padding: 16,
      borderRadius: 16,
      backgroundColor: theme.input,
      flexDirection: "row",
      alignItems: "flex-start",
      gap: 12,
    },
    deviceMain: {
      flex: 1,
      minWidth: 0,
      gap: 2,
    },
    deviceTitleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    deviceTitle: {
      flex: 1,
      color: theme.text,
      fontSize: 16,
      fontWeight: "600",
    },
    deviceHost: {
      color: theme.muted,
      fontSize: 13,
      lineHeight: 18,
    },
    deviceActions: {
      alignItems: "flex-end",
      gap: 6,
    },
    presenceDot: {
      width: 8,
      height: 8,
      borderRadius: 4,
    },
    sharedBadge: {
      color: theme.muted,
      fontSize: 12,
      fontStyle: "italic",
    },
    deviceMeta: {
      color: theme.muted,
      marginTop: 4,
      fontSize: 13,
    },
    delete: {
      color: theme.muted,
      fontSize: 13,
      fontWeight: "600",
      paddingVertical: 2,
    },
    shareAction: {
      color: theme.accent,
      fontSize: 14,
      fontWeight: "600",
      padding: 4,
    },
    deleteConfirm: {
      color: theme.error,
      fontSize: 14,
      fontWeight: "700",
      padding: 4,
    },
    promptBox: {
      marginTop: 8,
      gap: 8,
      padding: 12,
      borderRadius: 16,
      backgroundColor: theme.input,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 8,
    },
    inlineRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    flexGrow: {
      flex: 1,
    },
    label: {
      color: theme.text,
      fontSize: 14,
      fontWeight: "600",
    },
    optional: {
      color: theme.muted,
      fontWeight: "400",
    },
    input: {
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
      backgroundColor: theme.input,
      color: theme.text,
      fontSize: 16,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    smallButton: {
      borderRadius: 16,
      paddingVertical: 12,
      paddingHorizontal: 16,
      alignItems: "center",
      backgroundColor: theme.accent,
    },
    smallButtonLabel: {
      color: theme.accentText,
      fontWeight: "700",
      fontSize: 15,
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
    buttonDisabled: {
      opacity: 0.6,
    },
    link: {
      color: theme.accent,
      fontWeight: "600",
    },
    muted: {
      color: theme.muted,
      fontSize: 14,
      lineHeight: 20,
    },
    fieldError: {
      color: theme.error,
      fontSize: 13,
    },
    noticeText: {
      color: theme.accent,
      fontSize: 13,
    },
  });
}
