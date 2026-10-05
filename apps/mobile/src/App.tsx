import { useEffect, useRef, useState } from "react";
import { AppState, Linking, StatusBar, useColorScheme } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AccountProvider, useAccount } from "./account/AccountContext";
import { createMagicLinkGate, magicLinkFromUrl } from "./account/accountSession";
import { takePendingAuthURL } from "./native/NomadNativeModule";
import {
  darkTheme,
  HomeScreen,
  lightTheme,
  type MobileSession,
} from "./screens/HomeScreen";
import { LoginScreen } from "./screens/LoginScreen";
import { SettingsScreen } from "./screens/SettingsScreen";
import { ViewerScreen } from "./screens/ViewerScreen";

export function App() {
  const isDark = useColorScheme() !== "light";
  return (
    // Insets come from the provider: Android 15 draws edge-to-edge, and
    // react-native's own SafeAreaView only pads on iOS.
    <SafeAreaProvider>
      <StatusBar
        barStyle={isDark ? "light-content" : "dark-content"}
        translucent
        backgroundColor="transparent"
      />
      <AccountProvider>
        <Root />
      </AccountProvider>
    </SafeAreaProvider>
  );
}

type Screen = "home" | "login" | "settings";

function Root() {
  const account = useAccount();
  const [session, setSession] = useState<MobileSession | null>(null);
  const [screen, setScreen] = useState<Screen>("home");
  const [linkError, setLinkError] = useState<string | null>(null);
  const colorScheme = useColorScheme();
  const isDark = colorScheme !== "light";
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const completeLoginRef = useRef(account.completeLogin);
  completeLoginRef.current = account.completeLogin;
  const accountLoadingRef = useRef(account.loading);
  accountLoadingRef.current = account.loading;
  const signedInRef = useRef(account.session != null);
  signedInRef.current = account.session != null;
  const flushLinkRef = useRef<() => void>(() => {});

  // nomadvnc://auth/callback opens the app from the sign-in email. Listen
  // for the whole lifetime of the app, including while the account store is
  // still loading, so the link is not delivered with no listener attached.
  useEffect(() => {
    let alive = true;
    const gate = createMagicLinkGate();
    let queued: string | null = null;

    async function handle(url: string): Promise<void> {
      const token = magicLinkFromUrl(url);
      if (!alive || token == null) {
        return;
      }
      if (accountLoadingRef.current) {
        queued = url;
        return;
      }
      try {
        await gate.run(token, () => completeLoginRef.current(token));
        if (!alive) {
          return;
        }
        setLinkError(null);
        if (!sessionRef.current) {
          setScreen("home");
        }
      } catch (err) {
        // A second delivery of a link that already signed us in is not a
        // new failure. Leave the signed-in home screen alone.
        if (!alive || sessionRef.current || signedInRef.current) {
          return;
        }
        setLinkError(err instanceof Error ? err.message : "Sign-in failed");
        setScreen("login");
      }
    }

    async function pullNativeLink(): Promise<void> {
      try {
        const url = await takePendingAuthURL();
        if (url) {
          await handle(url);
        }
      } catch {
        // The email link can still be pasted into the sign-in box.
      }
    }

    const pendingPulls: ReturnType<typeof setTimeout>[] = [];
    function pullNativeLinkSoon(): void {
      void pullNativeLink();
      pendingPulls.push(
        setTimeout(() => {
          void pullNativeLink();
        }, 400),
      );
    }

    function flush(): void {
      if (queued == null || accountLoadingRef.current) {
        return;
      }
      const url = queued;
      queued = null;
      void handle(url);
    }
    flushLinkRef.current = flush;

    Linking.getInitialURL()
      .then((url) => {
        if (url) {
          void handle(url);
        }
      })
      .catch(() => {
        // Paste in the sign-in box still works.
      });
    const subscription = Linking.addEventListener("url", ({ url }) => {
      void handle(url);
    });
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        pullNativeLinkSoon();
      }
    });
    pullNativeLinkSoon();
    return () => {
      alive = false;
      flushLinkRef.current = () => {};
      subscription.remove();
      appState.remove();
      for (const timer of pendingPulls) {
        clearTimeout(timer);
      }
    };
  }, []);

  useEffect(() => {
    if (!account.loading) {
      flushLinkRef.current();
    }
  }, [account.loading]);

  if (session) {
    return (
      <ViewerScreen
        session={session}
        username={session.username}
        onClose={() => setSession(null)}
      />
    );
  }

  if (screen === "login") {
    return (
      <LoginScreen
        initialError={linkError}
        onDone={() => {
          setLinkError(null);
          setScreen("home");
        }}
        onCancel={() => {
          setLinkError(null);
          setScreen("home");
        }}
      />
    );
  }

  if (screen === "settings") {
    return (
      <SettingsScreen
        theme={isDark ? darkTheme : lightTheme}
        onBack={() => setScreen("home")}
      />
    );
  }

  return (
    <HomeScreen
      onConnect={setSession}
      onLogin={() => setScreen("login")}
      onSettings={() => setScreen("settings")}
    />
  );
}
