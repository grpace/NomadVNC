/**
 * React binding for the Nomad account state (`accountState.ts`). Loads the
 * persisted session on mount; everything else is driven by the framework-
 * free `AccountStateManager` so the logic stays unit-testable.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { AppState } from "react-native";
import type { AccountClient, BackendDeviceView, BackendSharedDeviceView } from "./accountClient";
import type { AccountConfig } from "./accountConfig";
import type { AccountSession } from "./accountSession";
import { AccountStateManager, type AccountStateDeps } from "./accountState";

export interface AccountContextValue {
  session: AccountSession | null;
  email: string | null;
  client: AccountClient;
  config: AccountConfig;
  devices: BackendDeviceView[];
  sharedDevices: BackendSharedDeviceView[];
  loading: boolean;
  error: string | null;
  requestMagicLink: (email: string) => Promise<void>;
  completeLogin: (rawInput: string) => Promise<void>;
  logout: () => Promise<void>;
  deleteAccount: () => Promise<void>;
  refreshDevices: () => Promise<void>;
  saveConfig: (baseUrl: string) => Promise<void>;
}

const AccountContext = createContext<AccountContextValue | null>(null);

export function AccountProvider({
  children,
  deps,
}: {
  children: ReactNode;
  deps?: AccountStateDeps;
}): React.JSX.Element {
  const [manager] = useState(() => new AccountStateManager(deps));
  const [tick, setTick] = useState(0);

  useEffect(() => manager.subscribe(() => setTick((t) => t + 1)), [manager]);
  useEffect(() => {
    // Back from the background: keep the sign-in fresh (no-op when recent).
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        void manager.refreshSessionIfDue();
      }
    });
    return () => sub.remove();
  }, [manager]);
  useEffect(() => {
    void manager.init().catch(() => {
      // init records a failed load as signed out. Swallowing here keeps
      // that failure from showing up as an unhandled-rejection warning.
    });
  }, [manager]);

  const value = useMemo<AccountContextValue>(
    () => ({
      session: manager.session,
      email: manager.session?.email ?? null,
      client: manager.client,
      config: manager.config,
      devices: manager.devices,
      sharedDevices: manager.sharedDevices,
      loading: manager.loading,
      error: manager.error,
      requestMagicLink: (email: string) => manager.requestMagicLink(email),
      completeLogin: (rawInput: string) => manager.completeLogin(rawInput),
      logout: () => manager.logout(),
      deleteAccount: () => manager.deleteAccount(),
      refreshDevices: () => manager.refreshDevices(),
      saveConfig: (baseUrl: string) => manager.saveConfig(baseUrl),
    }),
    // Rebuilt on every manager state change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [manager, tick],
  );

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount(): AccountContextValue {
  const value = useContext(AccountContext);
  if (!value) {
    throw new Error("useAccount must be used inside <AccountProvider>");
  }
  return value;
}
