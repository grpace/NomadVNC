import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { cardElevation, type Theme } from "../screens/HomeScreen";

const STEPS = [
  {
    title: "1. Install NomadVNC Host",
    body: "Optional. On the Windows PC, run NomadVNC-Host from Releases, or nomadvnc-host.exe, and approve the administrator prompt. Set the name you want to see on your other devices, set a password of 8 characters or fewer, and choose Install and Start. It shares the screen on port 5900, including the Windows sign-in screen, and starts at boot with no window. If you manage a fleet of computers, the setup guide has a silent install that does not open a window. TightVNC, or any other VNC server, still works if you already use it.",
  },
  {
    title: "2. Reach the PC",
    body: "On the same network, skip this and use the PC's address. Any VPN works: connect to the address that VPN gives the PC. Tailscale is optional. In NomadVNC Host, choose Sign In with Tailscale to join a tailnet without installing the Tailscale app. Sign in with the account that owns the tailnet. Setup stays on that step until you choose Disable Key Expiry for this PC on the Tailscale Machines page.",
  },
  {
    title: "3. Save the PC in NomadVNC",
    body: "After a Tailscale sign-in, add the PC from your tailnet list. On the local network, or through any other VPN, type its address. Use port 5900 and save the VNC password.",
  },
  {
    title: "4. Connect",
    body: "Tap the device card. While the PC is locked, you see the Windows sign-in screen.",
  },
];

/**
 * Server setup guide for a Windows PC running NomadVNC Host. The desktop
 * ships a Linux headless guide; mobile gets the Windows walkthrough here.
 */
export function ServerSetupGuide({ theme }: { theme: Theme }) {
  const styles = makeStyles(theme);
  const [expanded, setExpanded] = useState(false);

  return (
    <View style={styles.card}>
      <Pressable
        onPress={() => setExpanded((v) => !v)}
        style={styles.toggle}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        accessibilityLabel="Server setup guide"
      >
        <Text style={styles.cardTitle}>Setting Up a Windows PC?</Text>
        <Text style={styles.toggleHint}>{expanded ? "Hide Guide" : "Show Guide"}</Text>
      </Pressable>
      {expanded && (
        <View style={styles.steps}>
          {STEPS.map((step) => (
            <View key={step.title} style={styles.step}>
              <Text style={styles.stepTitle}>{step.title}</Text>
              <Text style={styles.stepBody}>{step.body}</Text>
            </View>
          ))}
        </View>
      )}
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
    toggle: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
    },
    cardTitle: {
      color: theme.text,
      fontSize: 15,
      fontWeight: "700",
    },
    toggleHint: {
      color: theme.accent,
      fontSize: 14,
      fontWeight: "600",
    },
    steps: {
      gap: 12,
    },
    step: {
      gap: 4,
    },
    stepTitle: {
      color: theme.text,
      fontSize: 15,
      fontWeight: "600",
    },
    stepBody: {
      color: theme.muted,
      fontSize: 14,
      lineHeight: 20,
    },
  });
}
