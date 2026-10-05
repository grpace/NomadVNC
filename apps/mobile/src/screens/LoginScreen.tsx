import { useEffect, useState } from "react";
import {
  KeyboardAvoidingView,
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
import { useAccount } from "../account/AccountContext";
import { cardElevation, CONTENT_MAX_WIDTH, darkTheme, lightTheme } from "./HomeScreen";
import { isValidAccountBaseUrl } from "../account/accountConfig";
import { isValidEmail } from "../account/deviceUi";

interface LoginScreenProps {
  onDone: () => void;
  onCancel: () => void;
  /** Set when a nomadvnc:// link was opened but sign-in did not finish. */
  initialError?: string | null;
}

/**
 * Nomad account sign-in. Step 1: email → magic link sent. Step 2: paste the
 * link or token from the email. Tapping the nomadvnc:// link is handled by
 * the app shell, including when this screen is not open.
 */
export function LoginScreen({ onDone, onCancel, initialError = null }: LoginScreenProps) {
  const insets = useSafeAreaInsets();
  const account = useAccount();
  const colorScheme = useColorScheme();
  const isDark = colorScheme !== "light";
  const theme = isDark ? darkTheme : lightTheme;
  const styles = makeStyles(theme);

  const [step, setStep] = useState<"email" | "token">("email");
  const [email, setEmail] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  // The screen stays mounted while the email link is opened, so a failure
  // that arrives later has to update the message already on screen.
  useEffect(() => {
    if (initialError) {
      setError(initialError);
    }
  }, [initialError]);
  // Self-hosters must be able to pick their server BEFORE signing in.
  const [editingServer, setEditingServer] = useState(false);
  const [serverDraft, setServerDraft] = useState(account.config.baseUrl);
  const [serverError, setServerError] = useState<string | null>(null);

  async function saveServer(): Promise<void> {
    const trimmed = serverDraft.trim();
    if (!isValidAccountBaseUrl(trimmed)) {
      setServerError("Enter a valid server URL, e.g. https://nomad.example.com");
      return;
    }
    try {
      await account.saveConfig(trimmed);
      setServerError(null);
      setEditingServer(false);
    } catch (err) {
      setServerError(err instanceof Error ? err.message : "Couldn't save the server");
    }
  }

  async function signInWith(raw: string): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await account.completeLogin(raw);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  async function sendLink(): Promise<void> {
    const trimmed = email.trim();
    if (!isValidEmail(trimmed)) {
      setError("Enter a valid email address");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await account.requestMagicLink(trimmed);
      setStep("token");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send the sign-in link");
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe} edges={["top", "left", "right"]}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: 32 + insets.bottom }]} keyboardShouldPersistTaps="handled">
          <View style={styles.intro}>
            <View style={styles.titleBlock}>
              <Text style={styles.eyebrow}>Nomad Account</Text>
              <Text style={styles.title}>Sign In</Text>
            </View>
            <Text style={styles.subtitle}>
              {step === "email"
                ? "We'll email you a sign-in link. Your devices and saved VNC passwords sync through your account."
                : "Check your email for the sign-in link. Tap it, or paste it below."}
            </Text>
          </View>

          <View style={styles.card}>
            {step === "email" ? (
              <>
                <View style={styles.field}>
                  <Text style={styles.label} nativeID="loginEmailLabel">
                    Email Address
                  </Text>
                  <TextInput
                    value={email}
                    onChangeText={setEmail}
                    placeholder="you@example.com"
                    placeholderTextColor={theme.placeholder}
                    style={styles.input}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                    accessibilityLabelledBy="loginEmailLabel"
                    returnKeyType="send"
                    onSubmitEditing={() => void sendLink()}
                  />
                </View>
                <Pressable
                  onPress={() => void sendLink()}
                  disabled={busy}
                  style={[styles.button, busy && styles.buttonDisabled]}
                  accessibilityRole="button"
                  accessibilityLabel="Send sign-in link"
                >
                  <Text style={styles.buttonLabel}>
                    {busy ? "Sending…" : "Send Sign-In Link"}
                  </Text>
                </Pressable>
                <View style={styles.cardMeta}>
                  {editingServer ? (
                    <>
                      <View style={styles.field}>
                        <Text style={styles.label} nativeID="loginServerLabel">
                          Account Server
                        </Text>
                        <TextInput
                          value={serverDraft}
                          onChangeText={setServerDraft}
                          placeholder="https://nomad.example.com"
                          placeholderTextColor={theme.placeholder}
                          style={styles.input}
                          keyboardType="url"
                          autoCapitalize="none"
                          autoCorrect={false}
                          accessibilityLabelledBy="loginServerLabel"
                          returnKeyType="done"
                          onSubmitEditing={() => void saveServer()}
                        />
                      </View>
                      {serverError && (
                        <Text style={styles.fieldError} role="alert">
                          {serverError}
                        </Text>
                      )}
                      <Pressable onPress={() => void saveServer()} style={styles.textAction} accessibilityRole="button" accessibilityLabel="Save account server">
                        <Text style={styles.link}>Save Server</Text>
                      </Pressable>
                    </>
                  ) : (
                    <Pressable
                      onPress={() => {
                        setServerDraft(account.config.baseUrl);
                        setEditingServer(true);
                      }}
                      style={styles.textAction}
                      accessibilityRole="button"
                      accessibilityLabel="Change account server"
                    >
                      <Text style={styles.muted}>
                        Server: {account.config.baseUrl.replace(/^https?:\/\//, "")}{" "}
                        <Text style={styles.link}>Change</Text>
                      </Text>
                    </Pressable>
                  )}
                </View>
              </>
            ) : (
              <>
                <View style={styles.field}>
                  <Text style={styles.label} nativeID="loginTokenLabel">
                    Sign-In Link or Token
                  </Text>
                  <TextInput
                    value={tokenInput}
                    onChangeText={setTokenInput}
                    placeholder="Paste the link from your email"
                    placeholderTextColor={theme.placeholder}
                    style={styles.input}
                    autoCapitalize="none"
                    autoCorrect={false}
                    accessibilityLabelledBy="loginTokenLabel"
                    returnKeyType="go"
                    onSubmitEditing={() => void signInWith(tokenInput)}
                  />
                </View>
                <Pressable
                  onPress={() => void signInWith(tokenInput)}
                  disabled={busy}
                  style={[styles.button, busy && styles.buttonDisabled]}
                  accessibilityRole="button"
                  accessibilityLabel="Sign in"
                >
                  <Text style={styles.buttonLabel}>
                    {busy ? "Signing In…" : "Sign In"}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    setStep("email");
                    setError(null);
                  }}
                  style={styles.textAction}
                  accessibilityRole="button"
                  accessibilityLabel="Use a different email"
                >
                  <Text style={styles.link}>Use a Different Email</Text>
                </Pressable>
              </>
            )}

            {error && (
              <Text style={styles.fieldError} role="alert">
                {error}
              </Text>
            )}

            <Pressable
              onPress={onCancel}
              style={styles.textAction}
              accessibilityRole="button"
              accessibilityLabel="Cancel sign-in"
            >
              <Text style={[styles.link, styles.center]}>Cancel</Text>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function makeStyles(theme: typeof darkTheme) {
  return StyleSheet.create({
    flex: { flex: 1 },
    safe: { flex: 1, backgroundColor: theme.bg },
    content: {
      paddingHorizontal: 24,
      paddingTop: 12,
      gap: 28,
      width: "100%",
      maxWidth: CONTENT_MAX_WIDTH,
      alignSelf: "center",
    },
    intro: {
      gap: 12,
    },
    titleBlock: {
      gap: 6,
    },
    eyebrow: {
      color: theme.accent,
      textTransform: "uppercase",
      letterSpacing: 1.4,
      fontSize: 12,
    },
    title: { color: theme.text, fontSize: 34, fontWeight: "700" },
    subtitle: { color: theme.muted, lineHeight: 22 },
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
    cardMeta: {
      gap: 12,
      paddingTop: 4,
    },
    label: { color: theme.muted, fontSize: 13, fontWeight: "600" },
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
    button: {
      borderRadius: 14,
      paddingVertical: 14,
      alignItems: "center",
      backgroundColor: theme.accent,
    },
    buttonDisabled: { opacity: 0.6 },
    buttonLabel: { color: theme.accentText, fontWeight: "700", fontSize: 16 },
    textAction: {
      paddingVertical: 6,
    },
    link: { color: theme.accent, fontWeight: "600", fontSize: 15 },
    muted: { color: theme.muted, fontSize: 14 },
    center: { textAlign: "center" },
    fieldError: { color: theme.error, fontSize: 13 },
  });
}
