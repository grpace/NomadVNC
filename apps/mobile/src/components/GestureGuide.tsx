import { StyleSheet, Text, View } from "react-native";
import type { PointerMode } from "@nomadvnc/viewer-shell";
import type { Theme } from "../screens/HomeScreen";

/**
 * The touch gestures for each pointer mode. Mirrors
 * packages/viewer-shell/src/input.mjs — keep the two in step.
 */
export function gestureRows(mode: PointerMode): Array<[string, string]> {
  const pointer: Array<[string, string]> =
    mode === "trackpad"
      ? [
          ["Slide One Finger", "Move the pointer"],
          ["Tap", "Click at the pointer"],
        ]
      : [
          ["Tap", "Click where you tap"],
          ["Drag One Finger", "Pan when zoomed in, otherwise move the pointer"],
        ];
  return [
    ...pointer,
    ["Two-Finger Tap", "Right click"],
    ["Three-Finger Tap", "Middle click"],
    ["Long Press", "Right click"],
    ["Long Press, Then Drag", "Click and drag"],
    ["Tap, Then Touch and Drag", "Click and drag"],
    ["Two-Finger Drag", "Scroll"],
    ["Pinch", "Zoom in and out (this screen only)"],
  ];
}

export const POINTER_MODE_LABELS: Record<PointerMode, string> = {
  touch: "Touch",
  trackpad: "Trackpad",
};

export const POINTER_MODE_HINTS: Record<PointerMode, string> = {
  touch: "Tap exactly where you want to click.",
  trackpad: "Use the screen like a laptop trackpad. Best for small text.",
};

interface GestureGuideProps {
  theme: Theme;
  mode: PointerMode;
}

export function GestureGuide({ theme, mode }: GestureGuideProps) {
  const styles = makeStyles(theme);
  return (
    <View style={styles.table} accessibilityRole="list">
      {gestureRows(mode).map(([gesture, action]) => (
        <View key={gesture} style={styles.row} accessible accessibilityLabel={`${gesture}: ${action}`}>
          <Text style={styles.gesture}>{gesture}</Text>
          <Text style={styles.action}>{action}</Text>
        </View>
      ))}
    </View>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    table: {
      gap: 8,
    },
    row: {
      flexDirection: "row",
      gap: 12,
    },
    gesture: {
      color: theme.text,
      fontSize: 14,
      fontWeight: "600",
      width: 150,
    },
    action: {
      color: theme.muted,
      fontSize: 14,
      flex: 1,
    },
  });
}
