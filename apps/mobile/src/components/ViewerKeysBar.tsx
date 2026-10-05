import type { RefObject } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import type { WebView } from "react-native-webview";
import type { ViewerCommand } from "@nomadvnc/viewer-shell";
import type { Theme } from "../screens/HomeScreen";

/* X11 keysyms (mirrors desktop ViewerPanel). */
export const XK = {
  Control_L: 0xffe3,
  Alt_L: 0xffe9,
  Shift_L: 0xffe1,
  Super_L: 0xffeb,
  Escape: 0xff1b,
  Tab: 0xff09,
  BackSpace: 0xff08,
  Delete: 0xffff,
  Home: 0xff50,
  Left: 0xff51,
  Up: 0xff52,
  Right: 0xff53,
  Down: 0xff54,
  Page_Up: 0xff55,
  Page_Down: 0xff56,
  End: 0xff57,
  F1: 0xffbe,
} as const;

/**
 * Sends a ViewerCommand to the noVNC bootstrap inside the WebView. The
 * bootstrap listens for `window` "message" events; we dispatch one directly
 * instead of `window.postMessage`, which the native bridge shim has
 * repurposed for viewer→RN events.
 */
export function sendViewerCommand(
  webView: RefObject<WebView | null>,
  command: ViewerCommand,
): void {
  const js = `window.dispatchEvent(new MessageEvent("message",{data:${JSON.stringify(command)}}));true;`;
  webView.current?.injectJavaScript(js);
}

interface ViewerKeysBarProps {
  theme: Theme;
  webViewRef: RefObject<WebView | null>;
  sticky: Record<number, boolean>;
  onToggleSticky: (keysym: number) => void;
  /** Whether the phone's own keyboard is showing. */
  softKeyboardVisible: boolean;
  onToggleSoftKeyboard: () => void;
  /** Types the device clipboard into the remote session as key presses. */
  onPasteAsTyping: () => void;
}

const TAP_KEYS: { label: string; keysym: number; a11y?: string }[] = [
  { label: "Esc", keysym: XK.Escape },
  { label: "Tab", keysym: XK.Tab },
  { label: "Del", keysym: XK.Delete },
  { label: "←", keysym: XK.Left, a11y: "Left arrow" },
  { label: "↑", keysym: XK.Up, a11y: "Up arrow" },
  { label: "↓", keysym: XK.Down, a11y: "Down arrow" },
  { label: "→", keysym: XK.Right, a11y: "Right arrow" },
  { label: "Home", keysym: XK.Home },
  { label: "End", keysym: XK.End },
  { label: "PgUp", keysym: XK.Page_Up, a11y: "Page up" },
  { label: "PgDn", keysym: XK.Page_Down, a11y: "Page down" },
];

const FUNCTION_KEYS = Array.from({ length: 12 }, (_, i) => ({
  label: `F${i + 1}`,
  keysym: XK.F1 + i,
}));

const STICKY_KEYS: { label: string; keysym: number }[] = [
  { label: "Ctrl", keysym: XK.Control_L },
  { label: "Alt", keysym: XK.Alt_L },
  { label: "Shift", keysym: XK.Shift_L },
  { label: "Win", keysym: XK.Super_L },
];

/**
 * Extra-keys bar, docked above the phone's keyboard: keys a phone keyboard
 * lacks. Tap keys send press+release; modifier chips are sticky toggles
 * that stay down (Ctrl, then type "c" = Ctrl+C) until tapped again.
 */
export function ViewerKeysBar({
  theme,
  webViewRef,
  sticky,
  onToggleSticky,
  softKeyboardVisible,
  onToggleSoftKeyboard,
  onPasteAsTyping,
}: ViewerKeysBarProps) {
  const styles = makeStyles(theme);

  function tapKeysym(keysym: number): void {
    sendViewerCommand(webViewRef, { type: "sendKeys", keysyms: [keysym] });
  }

  return (
    <View style={styles.bar}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
        keyboardShouldPersistTaps="always"
      >
        <Pressable
          onPress={onToggleSoftKeyboard}
          style={[styles.key, softKeyboardVisible && styles.keyActive]}
          accessibilityRole="togglebutton"
          accessibilityState={{ selected: softKeyboardVisible }}
          accessibilityLabel={softKeyboardVisible ? "Hide keyboard" : "Show keyboard"}
        >
          <Text style={[styles.keyLabel, softKeyboardVisible && styles.keyLabelActive]}>abc</Text>
        </Pressable>
        <View style={styles.divider} />
        {STICKY_KEYS.map((key) => {
          const active = !!sticky[key.keysym];
          return (
            <Pressable
              key={key.label}
              onPress={() => onToggleSticky(key.keysym)}
              style={[styles.key, active && styles.keyActive]}
              accessibilityRole="togglebutton"
              accessibilityState={{ selected: active }}
              accessibilityLabel={`Sticky ${key.label}`}
            >
              <Text style={[styles.keyLabel, active && styles.keyLabelActive]}>
                {key.label}
              </Text>
            </Pressable>
          );
        })}
        <View style={styles.divider} />
        {TAP_KEYS.map((key) => (
          <Pressable
            key={key.label}
            onPress={() => tapKeysym(key.keysym)}
            style={styles.key}
            accessibilityRole="button"
            accessibilityLabel={`Send ${key.a11y ?? key.label} key`}
          >
            <Text style={styles.keyLabel}>{key.label}</Text>
          </Pressable>
        ))}
        <View style={styles.divider} />
        <Pressable
          onPress={onPasteAsTyping}
          style={styles.key}
          accessibilityRole="button"
          accessibilityLabel="Paste: type your clipboard into the remote machine"
        >
          <Text style={styles.keyLabel}>Paste</Text>
        </Pressable>
        <Pressable
          onPress={() =>
            sendViewerCommand(webViewRef, {
              type: "sendKeyCombo",
              modifiers: [XK.Control_L, XK.Alt_L],
              key: XK.Delete,
            })
          }
          style={styles.key}
          accessibilityRole="button"
          accessibilityLabel="Send Control Alt Delete"
        >
          <Text style={styles.keyLabel}>Ctrl+Alt+Del</Text>
        </Pressable>
        <View style={styles.divider} />
        {FUNCTION_KEYS.map((key) => (
          <Pressable
            key={key.label}
            onPress={() => tapKeysym(key.keysym)}
            style={styles.key}
            accessibilityRole="button"
            accessibilityLabel={`Send ${key.label}`}
          >
            <Text style={styles.keyLabel}>{key.label}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    bar: {
      backgroundColor: theme.toolbar,
      borderTopWidth: 1,
      borderTopColor: theme.border,
      paddingVertical: 6,
    },
    scroll: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 12,
      gap: 8,
    },
    divider: {
      width: 1,
      alignSelf: "stretch",
      backgroundColor: theme.border,
      marginHorizontal: 4,
    },
    key: {
      borderRadius: 10,
      paddingVertical: 8,
      paddingHorizontal: 14,
      backgroundColor: theme.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    keyActive: {
      backgroundColor: theme.accent,
      borderColor: theme.accent,
    },
    keyLabel: {
      color: theme.text,
      fontSize: 14,
      fontWeight: "600",
    },
    keyLabelActive: {
      color: theme.accentText,
    },
  });
}
