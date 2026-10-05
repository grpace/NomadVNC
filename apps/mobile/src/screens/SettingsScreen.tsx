import { useEffect, useState } from "react";
import {
  Alert,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useAccount } from "../account/AccountContext";
import { isValidAccountBaseUrl } from "../account/accountConfig";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import {
  DEFAULT_MOBILE_SETTINGS,
  loadMobileSettings,
  QUALITY_OPTIONS,
  saveMobileSettings,
  type MobileScaleMode,
  type MobileSettings,
} from "../settings";
import { ServerSetupGuide } from "../components/ServerSetupGuide";
import {
  GestureGuide,
  POINTER_MODE_HINTS,
  POINTER_MODE_LABELS,
} from "../components/GestureGuide";
import { NomadNativeModule } from "../native/NomadNativeModule";
import type { PointerMode } from "@nomadvnc/viewer-shell";
import { cardElevation, CONTENT_MAX_WIDTH, type Theme } from "./HomeScreen";

interface SettingsScreenProps {
  theme: Theme;
  onBack: () => void;
}

const POINTER_MODES: PointerMode[] = ["touch", "trackpad"];

const SCALE_OPTIONS: { value: MobileScaleMode; label: string }[] = [
  { value: "fit", label: "Fit Screen" },
  { value: "actual", label: "Actual Size" },
];

/**
 * Mobile settings (Phase 3 parity). Mirrors the desktop SettingsPanel's
 * viewer-defaults and new-machine sections; window frame and auto-updates
 * are desktop-only and intentionally omitted.
 */
export function SettingsScreen({ theme, onBack }: SettingsScreenProps) {
  const insets = useSafeAreaInsets();
  const account = useAccount();
  const styles = makeStyles(theme);
  const [serverUrl, setServerUrl] = useState(account.config.baseUrl);
  const [serverUrlError, setServerUrlError] = useState<string | null>(null);
  const [accountNotice, setAccountNotice] = useState<string | null>(null);
  const [settings, setSettings] = useState<MobileSettings>(DEFAULT_MOBILE_SETTINGS);
  const [portText, setPortText] = useState(String(DEFAULT_MOBILE_SETTINGS.defaultVncPort));
  const [portError, setPortError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [storageStatus, setStorageStatus] = useState<string | null>(null);
  const [nameText, setNameText] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameStatus, setNameStatus] = useState<string | null>(null);
  const [nameBusy, setNameBusy] = useState(false);

  useEffect(() => {
    setServerUrl(account.config.baseUrl);
  }, [account.config.baseUrl]);

  useEffect(() => {
    void loadMobileSettings().then((s) => {
      setSettings(s);
      setPortText(String(s.defaultVncPort));
      setNameText(s.tailscaleHostname);
      setLoaded(true);
    });
    // Live secure-storage status (desktop parity: the desktop Settings
    // panel shows the OS keyring state rather than static copy).
    let alive = true;
    NomadNativeModule.getSecureStorageStatus()
      .then((s) => {
        if (alive) {
          setStorageStatus(
            s.available
              ? `Available. Saved passwords are encrypted by your phone's ${Platform.OS === "ios" ? "Keychain" : "Keystore"}.`
              : "Unavailable. Passwords are kept for this session only.",
          );
        }
      })
      .catch(() => {
        if (alive) setStorageStatus("Unavailable. Passwords are kept for this session only.");
      });
    return () => {
      alive = false;
    };
  }, []);

  async function update(partial: Partial<MobileSettings>): Promise<void> {
    const next = { ...settings, ...partial };
    setSettings(next);
    try {
      await saveMobileSettings(next);
    } catch {
      // Settings are best-effort; the in-memory value still applies.
    }
  }

  async function commitTailscaleName(): Promise<void> {
    if (nameBusy || nameText.trim() === settings.tailscaleHostname) return;
    setNameBusy(true);
    setNameError(null);
    setNameStatus(null);
    try {
      const result = await NomadNativeModule.setTailscaleHostname(nameText);
      const typed = nameText.trim();
      if (typed === "") {
        await update({ tailscaleHostname: "" });
        setNameStatus(`Using the automatic name, ${result.hostname}.`);
        return;
      }
      setNameText(result.hostname);
      await update({ tailscaleHostname: result.hostname });
      setNameStatus(
        result.applied
          ? `Updated on your tailnet as ${result.hostname}.`
          : `Saved as ${result.hostname}. Used the next time you sign in to Tailscale.`,
      );
    } catch (err) {
      setNameError(err instanceof Error ? err.message : "Couldn't save the Tailscale name");
    } finally {
      setNameBusy(false);
    }
  }

  async function saveServerUrl(): Promise<void> {
    if (!isValidAccountBaseUrl(serverUrl)) {
      setServerUrlError("Enter a valid server URL, e.g. https://api.example.com");
      return;
    }
    setServerUrlError(null);
    try {
      await account.saveConfig(serverUrl);
      await account.refreshDevices();
      setAccountNotice("Account server saved.");
    } catch (err) {
      setServerUrlError(err instanceof Error ? err.message : "Couldn't save the server URL");
    }
  }

  function confirmDeleteAccount(): void {
    Alert.alert(
      "Delete Your Nomad Account?",
      `This permanently deletes ${account.email ?? "your account"} and everything synced to it: devices, saved passwords, and shares. Devices saved only on this phone are kept. This can't be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete Account",
          style: "destructive",
          onPress: () => {
            account
              .deleteAccount()
              .then(() => setAccountNotice("Your Nomad account was deleted."))
              .catch((err: unknown) => {
                setServerUrlError(
                  err instanceof Error ? `Couldn't delete the account: ${err.message}` : "Couldn't delete the account.",
                );
              });
          },
        },
      ],
    );
  }

  function handlePortBlur(): void {
    const port = Number(portText.trim());
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setPortError("Port must be 1–65535");
      setPortText(String(settings.defaultVncPort));
      return;
    }
    setPortError(null);
    void update({ defaultVncPort: port });
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <ScrollView contentContainerStyle={[styles.scroll, { paddingBottom: 24 + insets.bottom }]}>
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back to home"
          hitSlop={12}
          style={styles.backRow}
        >
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <View style={styles.intro}>
          <Text style={styles.headerTitle}>Settings</Text>
          <Text style={styles.subtext}>
            App-wide defaults for new devices and remote sessions.
          </Text>
        </View>

        {account.session && (
          <View style={styles.card}>
            <Text style={styles.cardTitle}>Account</Text>
            <Text style={styles.hint}>{account.email}</Text>
            <View style={styles.field}>
              <Text style={styles.label}>Account Server</Text>
              <TextInput
                value={serverUrl}
                onChangeText={(value) => {
                  setServerUrl(value);
                  setAccountNotice(null);
                }}
                placeholder="https://api.example.com"
                placeholderTextColor={theme.placeholder}
                style={styles.input}
                autoCapitalize="none"
                autoCorrect={false}
                accessibilityLabel="Account server URL"
                returnKeyType="done"
                onSubmitEditing={() => void saveServerUrl()}
              />
              <Text style={styles.hint}>
                Address of your Nomad account service. Changing it reloads the computers synced from that server.
              </Text>
            </View>
            {serverUrlError && (
              <Text style={styles.fieldError} role="alert">
                {serverUrlError}
              </Text>
            )}
            {accountNotice && <Text style={styles.notice}>{accountNotice}</Text>}
            <Pressable
              onPress={() => void saveServerUrl()}
              disabled={serverUrl.trim() === account.config.baseUrl}
              style={[
                styles.saveButton,
                serverUrl.trim() === account.config.baseUrl && styles.saveButtonDisabled,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Save account server"
            >
              <Text style={styles.saveButtonLabel}>Save Server</Text>
            </Pressable>
            <Pressable
              onPress={() => void account.logout()}
              accessibilityRole="button"
              accessibilityLabel="Sign out"
            >
              <Text style={styles.back}>Sign Out</Text>
            </Pressable>
            <View style={styles.deleteAccountBlock}>
              <Text style={styles.hint}>
                Permanently deletes your Nomad account and everything synced to it. Devices saved only on this phone are kept.
              </Text>
              <Pressable
                onPress={confirmDeleteAccount}
                accessibilityRole="button"
                accessibilityLabel="Delete your Nomad account"
                hitSlop={8}
              >
                <Text style={styles.deleteAccountLabel}>Delete Account…</Text>
              </Pressable>
            </View>
          </View>
        )}

        <View style={styles.card}>
          <Text style={styles.cardTitle}>This Device</Text>
          <View style={styles.field}>
            <Text style={styles.label}>Tailscale Name</Text>
            <TextInput
              value={nameText}
              onChangeText={(value) => {
                setNameText(value);
                setNameStatus(null);
              }}
              onSubmitEditing={() => void commitTailscaleName()}
              placeholder="NomadVNC and this device's name"
              placeholderTextColor={theme.placeholder}
              style={styles.input}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Tailscale name"
              returnKeyType="done"
            />
            <Text style={styles.hint}>
              The name this phone uses on your tailnet. Leave blank for NomadVNC plus this device's name. Tap Save Name to apply it. That does not sign you in. If Tailscale is already connected, the name updates then.
            </Text>
            <Pressable
              onPress={() => void commitTailscaleName()}
              disabled={nameBusy || nameText.trim() === settings.tailscaleHostname}
              style={[
                styles.saveButton,
                (nameBusy || nameText.trim() === settings.tailscaleHostname) && styles.saveButtonDisabled,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Save Tailscale name"
              accessibilityState={{
                disabled: nameBusy || nameText.trim() === settings.tailscaleHostname,
                busy: nameBusy,
              }}
            >
              <Text style={styles.saveButtonLabel}>{nameBusy ? "Saving…" : "Save Name"}</Text>
            </Pressable>
            {nameError && (
              <Text style={styles.fieldError} role="alert">
                {nameError}
              </Text>
            )}
            {nameStatus && !nameError && <Text style={styles.hint}>{nameStatus}</Text>}
          </View>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Viewer Defaults</Text>

          <Text style={styles.label}>Scale Mode</Text>
          <View style={styles.optionRow}>
            {SCALE_OPTIONS.map((opt) => (
              <Pressable
                key={opt.value}
                onPress={() => void update({ scaleMode: opt.value })}
                style={[
                  styles.optionChip,
                  settings.scaleMode === opt.value && styles.optionChipActive,
                ]}
                accessibilityRole="radio"
                accessibilityState={{ selected: settings.scaleMode === opt.value }}
                accessibilityLabel={opt.label}
              >
                <Text
                  style={[
                    styles.optionLabel,
                    settings.scaleMode === opt.value && styles.optionLabelActive,
                  ]}
                >
                  {opt.label}
                </Text>
              </Pressable>
            ))}
          </View>

          <Text style={styles.label}>Quality</Text>
          <View style={styles.choiceList}>
            {QUALITY_OPTIONS.map((opt) => {
              const selected = settings.quality === opt.value;
              return (
                <Pressable
                  key={opt.value}
                  onPress={() => void update({ quality: opt.value })}
                  style={[styles.choice, selected && styles.choiceActive]}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={opt.label}
                >
                  <View style={[styles.radio, selected && styles.radioOn]} />
                  <Text style={[styles.choiceLabel, selected && styles.choiceLabelActive]}>
                    {opt.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          <Pressable
            onPress={() => void update({ autoQuality: !settings.autoQuality })}
            style={styles.checkRow}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: settings.autoQuality }}
            accessibilityLabel="Auto quality on slow connections"
          >
            <View style={[styles.checkMark, settings.autoQuality && styles.checkMarkOn]}>
              {settings.autoQuality && <Text style={styles.checkGlyph}>✓</Text>}
            </View>
            <Text style={styles.checkLabel}>Auto Quality on Slow Connections</Text>
          </Pressable>

          <Pressable
            onPress={() => void update({ clipboardSync: !settings.clipboardSync })}
            style={styles.checkRow}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: settings.clipboardSync }}
            accessibilityLabel="Sync clipboard with the remote machine"
          >
            <View style={[styles.checkMark, settings.clipboardSync && styles.checkMarkOn]}>
              {settings.clipboardSync && <Text style={styles.checkGlyph}>✓</Text>}
            </View>
            <Text style={styles.checkLabel}>Sync Clipboard with the Remote Machine</Text>
          </Pressable>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Touch Input</Text>
          <View style={styles.optionRow}>
            {POINTER_MODES.map((mode) => (
              <Pressable
                key={mode}
                onPress={() => void update({ pointerMode: mode })}
                style={[
                  styles.optionChip,
                  settings.pointerMode === mode && styles.optionChipActive,
                ]}
                accessibilityRole="radio"
                accessibilityState={{ selected: settings.pointerMode === mode }}
                accessibilityLabel={`${POINTER_MODE_LABELS[mode]} mode`}
              >
                <Text
                  style={[
                    styles.optionLabel,
                    settings.pointerMode === mode && styles.optionLabelActive,
                  ]}
                >
                  {POINTER_MODE_LABELS[mode]}
                </Text>
              </Pressable>
            ))}
          </View>
          <Text style={styles.hint}>
            {POINTER_MODE_HINTS[settings.pointerMode]} You can also switch during a session.
          </Text>
          <GestureGuide theme={theme} mode={settings.pointerMode} />
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>New Devices</Text>
          <Text style={styles.label}>Default VNC Port</Text>
          <TextInput
            value={portText}
            onChangeText={setPortText}
            onBlur={handlePortBlur}
            placeholder="5900"
            placeholderTextColor={theme.placeholder}
            style={styles.input}
            keyboardType="numeric"
            accessibilityLabel="Default VNC port"
          />
          {portError && (
            <Text style={styles.fieldError} role="alert">
              {portError}
            </Text>
          )}
          <Text style={styles.hint}>
            Prefilled automatically when adding a device.
          </Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Password Storage</Text>
          <Text style={styles.hint}>
            {storageStatus ??
              "Saved VNC passwords are kept in your device's secure storage (iOS Keychain or Android Keystore), never in plain text. Account session tokens use the same secure storage."}
          </Text>
        </View>

        <ServerSetupGuide theme={theme} />

        <View style={styles.card}>
          <Text style={styles.cardTitle}>About</Text>
          <Text style={styles.hint}>
            NomadVNC is open source under the Apache-2.0 license and includes
            third-party components under their own licenses.
          </Text>
          <Pressable
            onPress={() => void Linking.openURL("https://github.com/grpace/NomadVNC")}
            accessibilityRole="link"
            accessibilityLabel="View source code"
          >
            <Text style={styles.back}>Source Code</Text>
          </Pressable>
          <Pressable
            onPress={() => void Linking.openURL("https://github.com/grpace/NomadVNC/blob/master/THIRD_PARTY_NOTICES.md")}
            accessibilityRole="link"
            accessibilityLabel="Open-source licenses"
          >
            <Text style={styles.back}>Open-Source Licenses</Text>
          </Pressable>
          <Pressable
            onPress={() => void Linking.openURL("https://greg.tech/nomadvnc/privacy")}
            accessibilityRole="link"
            accessibilityLabel="Privacy policy"
          >
            <Text style={styles.back}>Privacy Policy</Text>
          </Pressable>
          <Pressable
            onPress={() => void Linking.openURL("https://greg.tech/nomadvnc/support")}
            accessibilityRole="link"
            accessibilityLabel="Help and support"
          >
            <Text style={styles.back}>Help and Support</Text>
          </Pressable>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Credits</Text>
          <Text style={styles.hint}>
            NomadVNC is free and open source. Buy Me a Coffee supports continued development.
          </Text>
          <Pressable
            onPress={() => void Linking.openURL("https://buymeacoffee.com/greg.tech")}
            accessibilityRole="link"
            accessibilityLabel="Buy Me a Coffee"
          >
            <Text style={styles.back}>Buy Me a Coffee</Text>
          </Pressable>
        </View>

        {!loaded && <Text style={styles.hint}>Loading settings…</Text>}
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    safe: {
      flex: 1,
      backgroundColor: theme.bg,
    },
    backRow: {
      alignSelf: "flex-start",
    },
    back: {
      color: theme.accent,
      fontSize: 17,
      fontWeight: "600",
    },
    intro: {
      gap: 8,
    },
    headerTitle: {
      color: theme.text,
      fontSize: 34,
      fontWeight: "700",
    },
    scroll: {
      paddingHorizontal: 24,
      paddingTop: 12,
      gap: 20,
      width: "100%",
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: "center",
    },
    subtext: {
      color: theme.muted,
      fontSize: 15,
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
    cardTitle: {
      color: theme.text,
      fontSize: 15,
      fontWeight: "700",
      paddingBottom: 14,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    field: {
      gap: 8,
    },
    label: {
      color: theme.muted,
      fontSize: 13,
      fontWeight: "600",
    },
    hint: {
      color: theme.muted,
      fontSize: 13,
      lineHeight: 18,
    },
    optionRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
    },
    optionChip: {
      flexGrow: 1,
      alignItems: "center",
      borderRadius: 12,
      paddingVertical: 12,
      paddingHorizontal: 14,
      backgroundColor: theme.input,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    choiceList: {
      gap: 8,
    },
    choice: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      borderRadius: 12,
      paddingVertical: 12,
      paddingHorizontal: 14,
      backgroundColor: theme.input,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    choiceActive: {
      borderColor: theme.accent,
      backgroundColor: theme.card,
    },
    choiceLabel: {
      color: theme.text,
      fontSize: 15,
      fontWeight: "600",
    },
    choiceLabelActive: {
      color: theme.text,
    },
    radio: {
      width: 18,
      height: 18,
      borderRadius: 9,
      borderWidth: 1.5,
      borderColor: theme.border,
      backgroundColor: theme.card,
    },
    radioOn: {
      borderColor: theme.accent,
      backgroundColor: theme.accent,
    },
    optionChipActive: {
      backgroundColor: theme.accent,
      borderColor: theme.accent,
    },
    optionLabel: {
      color: theme.text,
      fontSize: 14,
      fontWeight: "600",
    },
    optionLabelActive: {
      color: theme.accentText,
    },
    checkRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      paddingVertical: 4,
    },
    checkMark: {
      width: 22,
      height: 22,
      borderRadius: 6,
      borderWidth: 1.5,
      borderColor: theme.border,
      backgroundColor: theme.input,
      alignItems: "center",
      justifyContent: "center",
    },
    checkMarkOn: {
      borderColor: theme.accent,
      backgroundColor: theme.accent,
    },
    checkGlyph: {
      color: theme.accentText,
      fontSize: 14,
      fontWeight: "700",
      lineHeight: 16,
    },
    checkLabel: {
      color: theme.text,
      fontSize: 15,
      fontWeight: "600",
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
    fieldError: {
      color: theme.error,
      fontSize: 13,
    },
    notice: {
      color: theme.accent,
      fontSize: 13,
    },
    deleteAccountBlock: {
      gap: 12,
      paddingTop: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
    },
    deleteAccountLabel: {
      color: theme.error,
      fontSize: 15,
      fontWeight: "600",
    },
    saveButton: {
      alignSelf: "flex-start",
      borderRadius: 12,
      paddingVertical: 12,
      paddingHorizontal: 18,
      backgroundColor: theme.accent,
    },
    saveButtonDisabled: {
      opacity: 0.45,
    },
    saveButtonLabel: {
      color: theme.accentText,
      fontSize: 15,
      fontWeight: "700",
    },
  });
}
