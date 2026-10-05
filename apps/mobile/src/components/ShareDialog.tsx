import { useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useAccount } from "../account/AccountContext";
import {
  type BackendShareView,
  type ShareGrantInput,
} from "../account/accountClient";
import type { Theme } from "../screens/HomeScreen";
import {
  daysToIso,
  parseShareDays,
  SHARE_MAX_KEY_DAYS,
  shareExpiryLabel,
  type ShareExpiryTone,
} from "./shareExpiry";

interface ShareDialogProps {
  visible: boolean;
  theme: Theme;
  deviceId: string;
  deviceLabel: string;
  onClose: () => void;
  onNotice: (message: string, variant: "info" | "success" | "error") => void;
}

const TONE_COLORS: Record<ShareExpiryTone, (theme: Theme) => string> = {
  ok: (t) => t.accent,
  warn: () => "#ffb020",
  bad: (t) => t.error,
  plain: (t) => t.muted,
};

/**
 * Share a saved device (Phase 2 parity). Mirrors the desktop ShareDialog:
 * email grants with optional Tailscale auth-key passing, rekey, key removal,
 * and revocation — all backed by the same /api/v1/* routes.
 */
export function ShareDialog({
  visible,
  theme,
  deviceId,
  deviceLabel,
  onClose,
  onNotice,
}: ShareDialogProps) {
  const account = useAccount();
  const styles = makeStyles(theme);

  const [shares, setShares] = useState<BackendShareView[]>([]);
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [includeKey, setIncludeKey] = useState(true);
  const [keyInput, setKeyInput] = useState("");
  const [daysInput, setDaysInput] = useState("30");
  const [rekeyingId, setRekeyingId] = useState<string | null>(null);
  const [rekeyKey, setRekeyKey] = useState("");
  const [rekeyDays, setRekeyDays] = useState("30");
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function loadShares(): Promise<void> {
    setLoading(true);
    try {
      setShares(await account.client.listShares(deviceId));
    } catch (err) {
      onNotice(err instanceof Error ? err.message : "Couldn't load shares", "error");
    } finally {
      setLoading(false);
    }
  }

  async function run(key: string, task: () => Promise<void>): Promise<void> {
    setBusy(key);
    try {
      await task();
      await loadShares();
    } catch (err) {
      onNotice(err instanceof Error ? err.message : "Share request failed", "error");
    } finally {
      setBusy(null);
    }
  }

  function handleOpen(): void {
    setShares([]);
    setConfirmRevokeId(null);
    setRekeyingId(null);
    void loadShares();
  }

  function handleGrant(): void {
    const address = email.trim();
    if (address === "") {
      onNotice("Enter the email address to share with.", "error");
      return;
    }
    let input: ShareGrantInput = { email: address };
    if (includeKey) {
      const key = keyInput.trim();
      if (key === "") {
        onNotice(
          "Paste the Tailscale auth key, or untick key-passing for same-tailnet sharing.",
          "error",
        );
        return;
      }
      const days = parseShareDays(daysInput);
      if (days === null) {
        onNotice(`Key expiry must be 1–${SHARE_MAX_KEY_DAYS} days.`, "error");
        return;
      }
      input = { email: address, tailnetAuthKey: key, keyExpiresAt: daysToIso(days) };
    }
    void run("grant", async () => {
      const { inviteSent } = await account.client.createShare(deviceId, input);
      setEmail("");
      setKeyInput("");
      onNotice(
        inviteSent
          ? `Shared with ${address}. Invite emailed.`
          : `Shared with ${address}. Mail isn't configured, so tell them yourself.`,
        "success",
      );
    });
  }

  function handleRekey(shareId: string): void {
    const key = rekeyKey.trim();
    if (key === "") {
      onNotice("Paste the fresh Tailscale auth key.", "error");
      return;
    }
    const days = parseShareDays(rekeyDays);
    if (days === null) {
      onNotice(`Key expiry must be 1–${SHARE_MAX_KEY_DAYS} days.`, "error");
      return;
    }
    void run(`rekey:${shareId}`, async () => {
      await account.client.updateShareKey(deviceId, shareId, {
        tailnetAuthKey: key,
        keyExpiresAt: daysToIso(days),
      });
      setRekeyingId(null);
      setRekeyKey("");
      onNotice("Tailnet key replaced. No re-invite needed.", "success");
    });
  }

  const busyAny = busy !== null;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onShow={handleOpen}
      onRequestClose={onClose}
      accessibilityLabel={`Share ${deviceLabel}`}
    >
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close share dialog">
        <Pressable style={styles.sheet} onPress={() => {}}>
          <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
            <Text style={styles.title}>Share “{deviceLabel}”</Text>
            <Text style={styles.body}>
              Grants stay live until revoked. The key is the grantee's connect
              credential for this device, but they must already be on your tailnet
              (for example, your company Tailscale). The key alone doesn't grant
              tailnet access. Same-tailnet shares need no key and never expire. We never proxy VNC.
            </Text>

            {loading ? (
              <Text style={styles.muted}>Loading grants…</Text>
            ) : shares.length === 0 ? (
              <Text style={styles.muted}>Not shared with anyone yet.</Text>
            ) : (
              shares.map((share) => {
                const expiry = shareExpiryLabel(share);
                const expanded = rekeyingId === share.id;
                return (
                  <View key={share.id} style={styles.shareCard}>
                    <Text style={styles.shareEmail}>{share.granteeEmail}</Text>
                    <Text style={[styles.expiry, { color: TONE_COLORS[expiry.tone](theme) }]}>
                      {expiry.text}
                    </Text>
                    <View style={styles.row}>
                      {share.hasTailnetKey && !expanded && (
                        <Pressable
                          onPress={() => {
                            setRekeyingId(share.id);
                            setRekeyKey("");
                            setRekeyDays("30");
                          }}
                          disabled={busyAny}
                          style={styles.chipButton}
                          accessibilityRole="button"
                          accessibilityLabel={`Replace key for ${share.granteeEmail}`}
                        >
                          <Text style={styles.chipLabel}>Replace Key</Text>
                        </Pressable>
                      )}
                      {confirmRevokeId === share.id ? (
                        <>
                          <Pressable
                            onPress={() =>
                              void run(`revoke:${share.id}`, async () => {
                                await account.client.deleteShare(deviceId, share.id);
                                setConfirmRevokeId(null);
                                onNotice(
                                  `Sharing with ${share.granteeEmail} revoked.`,
                                  "info",
                                );
                              })
                            }
                            disabled={busyAny}
                            style={[styles.chipButton, styles.dangerChip]}
                            accessibilityRole="button"
                            accessibilityLabel={`Confirm revoke ${share.granteeEmail}`}
                          >
                            <Text style={styles.chipLabel}>
                              {busy === `revoke:${share.id}` ? "Revoking…" : "Confirm"}
                            </Text>
                          </Pressable>
                          <Pressable
                            onPress={() => setConfirmRevokeId(null)}
                            disabled={busyAny}
                            style={styles.chipButton}
                            accessibilityRole="button"
                            accessibilityLabel="Keep share"
                          >
                            <Text style={styles.chipLabel}>Keep</Text>
                          </Pressable>
                        </>
                      ) : (
                        <Pressable
                          onPress={() => setConfirmRevokeId(share.id)}
                          disabled={busyAny}
                          style={styles.chipButton}
                          accessibilityRole="button"
                          accessibilityLabel={`Revoke ${share.granteeEmail}`}
                        >
                          <Text style={styles.chipLabel}>Revoke</Text>
                        </Pressable>
                      )}
                    </View>
                    {expanded && (
                      <View style={styles.rekeyBox}>
                        <TextInput
                          value={rekeyKey}
                          onChangeText={setRekeyKey}
                          placeholder="Paste the fresh Tailscale auth key"
                          placeholderTextColor={theme.placeholder}
                          style={styles.input}
                          autoCapitalize="none"
                          autoCorrect={false}
                          accessibilityLabel="Fresh Tailscale auth key"
                        />
                        <TextInput
                          value={rekeyDays}
                          onChangeText={setRekeyDays}
                          placeholder="Days (1–90)"
                          placeholderTextColor={theme.placeholder}
                          style={styles.input}
                          keyboardType="numeric"
                          accessibilityLabel="Key expiry in days"
                          returnKeyType="done"
                          onSubmitEditing={() => handleRekey(share.id)}
                        />
                        <View style={styles.row}>
                          <Pressable
                            onPress={() => handleRekey(share.id)}
                            disabled={busyAny}
                            style={styles.primaryButton}
                            accessibilityRole="button"
                            accessibilityLabel="Save new key"
                          >
                            <Text style={styles.primaryLabel}>
                              {busy === `rekey:${share.id}` ? "Saving…" : "Save Key"}
                            </Text>
                          </Pressable>
                          <Pressable
                            onPress={() => setRekeyingId(null)}
                            disabled={busyAny}
                            style={styles.chipButton}
                            accessibilityRole="button"
                            accessibilityLabel="Cancel rekey"
                          >
                            <Text style={styles.chipLabel}>Cancel</Text>
                          </Pressable>
                          <Pressable
                            onPress={() =>
                              void run(`clear:${share.id}`, async () => {
                                await account.client.updateShareKey(deviceId, share.id, {
                                  tailnetAuthKey: null,
                                });
                                setRekeyingId(null);
                                onNotice(
                                  "Key removed. The grant is same-tailnet only now.",
                                  "info",
                                );
                              })
                            }
                            disabled={busyAny}
                            style={styles.chipButton}
                            accessibilityRole="button"
                            accessibilityLabel="Remove key from share"
                          >
                            <Text style={styles.chipLabel}>Remove Key</Text>
                          </Pressable>
                        </View>
                      </View>
                    )}
                  </View>
                );
              })
            )}

            <Text style={styles.sectionTitle}>New Share</Text>
            <Text style={styles.label}>Share With</Text>
            <TextInput
              value={email}
              onChangeText={setEmail}
              placeholder="friend@example.com"
              placeholderTextColor={theme.placeholder}
              style={styles.input}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Email to share with"
              returnKeyType={includeKey ? "next" : "send"}
              onSubmitEditing={() => {
                if (!includeKey) handleGrant();
              }}
            />
            <Pressable
              onPress={() => setIncludeKey((v) => !v)}
              style={styles.checkRow}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: includeKey }}
              accessibilityLabel="Attach Tailnet Auth Key"
            >
              <View style={[styles.checkMark, includeKey && styles.checkMarkOn]}>
                {includeKey ? <Text style={styles.checkGlyph}>✓</Text> : null}
              </View>
              <View style={styles.flexGrow}>
                <Text style={styles.checkTitle}>Attach Tailnet Auth Key</Text>
                <Text style={styles.checkHint}>
                  Mint a reusable, ephemeral, tagged key in Tailscale admin (7–30d)
                  and paste it as their connect credential. They must already be on
                  your tailnet. The key doesn't grant tailnet access by itself.
                  Untick for same-tailnet sharing.
                </Text>
              </View>
            </Pressable>
            {includeKey && (
              <>
                <Text style={styles.label}>Tailscale Auth Key</Text>
                <TextInput
                  value={keyInput}
                  onChangeText={setKeyInput}
                  placeholder="tskey-auth-…"
                  placeholderTextColor={theme.placeholder}
                  style={styles.input}
                  autoCapitalize="none"
                  autoCorrect={false}
                  accessibilityLabel="Tailscale auth key"
                />
                <Text style={styles.label}>Key Expiry (Days)</Text>
                <TextInput
                  value={daysInput}
                  onChangeText={setDaysInput}
                  placeholder="30"
                  placeholderTextColor={theme.placeholder}
                  style={styles.input}
                  keyboardType="numeric"
                  accessibilityLabel="Key expiry in days"
                  returnKeyType="send"
                  onSubmitEditing={handleGrant}
                />
              </>
            )}

            <View style={styles.actions}>
              <Pressable
                onPress={onClose}
                disabled={busyAny}
                style={styles.secondaryButton}
                accessibilityRole="button"
                accessibilityLabel="Close share dialog"
              >
                <Text style={styles.secondaryLabel}>Close</Text>
              </Pressable>
              <Pressable
                onPress={handleGrant}
                disabled={busyAny || email.trim() === ""}
                style={[
                  styles.primaryButton,
                  (busyAny || email.trim() === "") && styles.buttonDisabled,
                ]}
                accessibilityRole="button"
                accessibilityLabel="Share device"
              >
                <Text style={styles.primaryLabel}>
                  {busy === "grant" ? "Sharing…" : "Share"}
                </Text>
              </Pressable>
            </View>
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.55)",
      justifyContent: "flex-end",
    },
    sheet: {
      backgroundColor: theme.card,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
      maxHeight: "88%",
    },
    scroll: {
      padding: 20,
      gap: 12,
    },
    title: {
      color: theme.text,
      fontSize: 20,
      fontWeight: "700",
    },
    body: {
      color: theme.muted,
      fontSize: 14,
      lineHeight: 20,
    },
    muted: {
      color: theme.muted,
      fontSize: 14,
    },
    shareCard: {
      backgroundColor: theme.input,
      borderRadius: 16,
      padding: 14,
      gap: 8,
    },
    shareEmail: {
      color: theme.text,
      fontSize: 16,
      fontWeight: "600",
    },
    expiry: {
      fontSize: 13,
      fontWeight: "600",
    },
    sectionTitle: {
      color: theme.text,
      fontSize: 16,
      fontWeight: "700",
      marginTop: 8,
    },
    label: {
      color: theme.text,
      fontSize: 14,
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
    row: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      flexWrap: "wrap",
    },
    flexGrow: {
      flex: 1,
    },
    chipButton: {
      borderRadius: 12,
      paddingVertical: 8,
      paddingHorizontal: 12,
      backgroundColor: theme.input,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    dangerChip: {
      borderColor: theme.error,
    },
    chipLabel: {
      color: theme.text,
      fontSize: 14,
      fontWeight: "600",
    },
    rekeyBox: {
      gap: 8,
    },
    checkRow: {
      flexDirection: "row",
      gap: 10,
      alignItems: "flex-start",
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
      marginTop: 1,
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
    checkTitle: {
      color: theme.text,
      fontSize: 15,
      fontWeight: "600",
    },
    checkHint: {
      color: theme.muted,
      fontSize: 13,
      lineHeight: 18,
      marginTop: 2,
    },
    actions: {
      flexDirection: "row",
      justifyContent: "flex-end",
      gap: 12,
      marginTop: 8,
    },
    primaryButton: {
      borderRadius: 16,
      paddingVertical: 12,
      paddingHorizontal: 20,
      alignItems: "center",
      backgroundColor: theme.accent,
    },
    primaryLabel: {
      color: theme.accentText,
      fontWeight: "700",
      fontSize: 15,
    },
    secondaryButton: {
      borderRadius: 14,
      paddingVertical: 12,
      paddingHorizontal: 20,
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
      opacity: 0.5,
    },
  });
}
