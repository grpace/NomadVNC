import type { ReactNode } from "react";
import { Pressable, StyleSheet, type StyleProp, Text, View, type ViewStyle } from "react-native";
import { darkTheme, type Theme } from "../screens/HomeScreen";

interface SessionToolbarProps {
  theme: Theme;
  title: string;
  connected: boolean;
  keyboardOpen: boolean;
  displayOpen: boolean;
  /** A dot on the Display button, for something waiting in that menu. */
  displayAttention?: boolean;
  onToggleKeyboard: () => void;
  onToggleDisplay: () => void;
  onDisconnect: () => void;
  onHide: () => void;
}

/**
 * Session chrome: the computer's name, icon buttons for keyboard and
 * display, and a disconnect control that doesn't look like the others.
 */
export function SessionToolbar({
  theme,
  title,
  connected,
  keyboardOpen,
  displayOpen,
  displayAttention = false,
  onToggleKeyboard,
  onToggleDisplay,
  onDisconnect,
  onHide,
}: SessionToolbarProps) {
  const isDark = theme.bg === darkTheme.bg;
  const styles = makeStyles(theme, isDark);
  const icon = theme.text;
  const active = theme.accent;

  return (
    <View style={styles.bar}>
      {connected ? (
        <Pressable
          onPress={onHide}
          style={styles.hide}
          accessibilityRole="button"
          accessibilityLabel="Hide toolbar"
          hitSlop={8}
        >
          <Chevron color={theme.muted} />
        </Pressable>
      ) : (
        <View style={styles.hide} />
      )}
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      <View style={styles.actions}>
        {connected && (
          <ToolButton
            label="Toggle keyboard"
            selected={keyboardOpen}
            onPress={onToggleKeyboard}
            style={[styles.tool, keyboardOpen && styles.toolActive]}
          >
            <KeyboardIcon color={keyboardOpen ? active : icon} />
          </ToolButton>
        )}
        {connected && (
          <View>
            <ToolButton
              label="Toggle display and input options"
              selected={displayOpen}
              onPress={onToggleDisplay}
              style={[styles.tool, displayOpen && styles.toolActive]}
            >
              <DisplayIcon color={displayOpen ? active : icon} />
            </ToolButton>
            {displayAttention && <View style={styles.attention} pointerEvents="none" />}
          </View>
        )}
        <ToolButton
          label="Disconnect from VNC session"
          onPress={onDisconnect}
          style={styles.disconnect}
        >
          <PowerIcon color={theme.error} cutout={isDark ? "#2a1518" : "#f8e8e8"} />
        </ToolButton>
      </View>
    </View>
  );
}

function ToolButton({
  label,
  selected,
  onPress,
  style,
  children,
}: {
  label: string;
  selected?: boolean;
  onPress: () => void;
  style: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={style}
      accessibilityRole={selected === undefined ? "button" : "togglebutton"}
      accessibilityLabel={label}
      accessibilityState={selected === undefined ? undefined : { selected }}
      hitSlop={4}
    >
      {children}
    </Pressable>
  );
}

function KeyboardIcon({ color }: { color: string }) {
  const key = { width: 3, height: 3, borderRadius: 0.5, backgroundColor: color };
  return (
    <View style={[iconStyles.keyboard, { borderColor: color }]}>
      <View style={iconStyles.keyRow}>
        <View style={key} />
        <View style={key} />
        <View style={key} />
        <View style={key} />
      </View>
      <View style={iconStyles.keyRow}>
        <View style={key} />
        <View style={key} />
        <View style={key} />
        <View style={key} />
      </View>
      <View style={[iconStyles.spacebar, { backgroundColor: color }]} />
    </View>
  );
}

function DisplayIcon({ color }: { color: string }) {
  return (
    <View style={iconStyles.display}>
      <View style={[iconStyles.screen, { borderColor: color }]} />
      <View style={[iconStyles.stand, { backgroundColor: color }]} />
      <View style={[iconStyles.standFoot, { backgroundColor: color }]} />
    </View>
  );
}

/** Power symbol: a ring with a gap, and a stem through the gap. */
function PowerIcon({ color, cutout }: { color: string; cutout: string }) {
  return (
    <View style={iconStyles.power}>
      <View style={[iconStyles.powerRing, { borderColor: color }]} />
      <View style={[iconStyles.powerGap, { backgroundColor: cutout }]} />
      <View style={[iconStyles.powerStem, { backgroundColor: color }]} />
    </View>
  );
}

function Chevron({ color }: { color: string }) {
  return <View style={[iconStyles.chevron, { borderColor: color }]} />;
}

/** Upward chevron for the "show toolbar" pill. */
export function ToolbarChevron({ color }: { color: string }) {
  return <View style={[iconStyles.chevron, iconStyles.chevronUp, { borderColor: color }]} />;
}

const iconStyles = StyleSheet.create({
  keyboard: {
    width: 22,
    height: 16,
    borderWidth: 1.5,
    borderRadius: 3,
    paddingHorizontal: 2,
    paddingVertical: 2,
    justifyContent: "space-between",
  },
  keyRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  spacebar: {
    alignSelf: "center",
    width: 10,
    height: 2.5,
    borderRadius: 1,
  },
  display: {
    alignItems: "center",
    width: 20,
  },
  screen: {
    width: 20,
    height: 13,
    borderWidth: 1.5,
    borderRadius: 2,
  },
  stand: {
    width: 2,
    height: 2,
  },
  standFoot: {
    width: 10,
    height: 1.5,
    borderRadius: 1,
  },
  power: {
    width: 18,
    height: 18,
  },
  powerRing: {
    position: "absolute",
    left: 1,
    top: 3,
    width: 16,
    height: 15,
    borderRadius: 8,
    borderWidth: 2,
  },
  powerGap: {
    position: "absolute",
    left: 6,
    top: 1,
    width: 6,
    height: 5,
  },
  powerStem: {
    position: "absolute",
    left: 8,
    top: 0,
    width: 2,
    height: 9,
    borderRadius: 1,
  },
  chevron: {
    width: 9,
    height: 9,
    borderRightWidth: 2,
    borderBottomWidth: 2,
    transform: [{ rotate: "45deg" }],
    marginTop: -3,
  },
  chevronUp: {
    transform: [{ rotate: "-135deg" }],
    marginTop: 3,
  },
});

function makeStyles(theme: Theme, isDark: boolean) {
  return StyleSheet.create({
    bar: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      paddingLeft: 4,
      paddingRight: 8,
      paddingVertical: 6,
      backgroundColor: theme.toolbar,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    hide: {
      width: 36,
      height: 40,
      alignItems: "center",
      justifyContent: "center",
    },
    title: {
      flex: 1,
      color: theme.text,
      fontSize: 15,
      fontWeight: "600",
    },
    actions: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    tool: {
      width: 40,
      height: 40,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: theme.card,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    toolActive: {
      borderWidth: 1.5,
      borderColor: theme.accent,
    },
    attention: {
      position: "absolute",
      top: 6,
      right: 6,
      width: 8,
      height: 8,
      borderRadius: 4,
      backgroundColor: theme.accent,
      borderWidth: 1.5,
      borderColor: theme.toolbar,
    },
    disconnect: {
      width: 40,
      height: 40,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
      marginLeft: 4,
      backgroundColor: isDark ? "#3A1E24" : "#FDECEC",
    },
  });
}
