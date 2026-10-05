import { useState } from "react";
import type { TailnetState } from "@nomadvnc/domain";
import { describeKeyExpiry, formatDaysLeft } from "../keyExpiry";

interface SidebarHeaderProps {
  tailnetState: TailnetState | null;
  activeSessionLabel?: string;
  /** live = handshake done; connecting = handshaking or auto-retrying; down = waiting on the user. */
  sessionState?: "live" | "connecting" | "down";
  isRefreshing: boolean;
  onSignOut?: () => void;
  onResetIdentity?: () => void;
}

export function SidebarHeader({
  tailnetState,
  activeSessionLabel,
  sessionState = "live",
  isRefreshing,
  onSignOut,
  onResetIdentity,
}: SidebarHeaderProps) {
  const [confirmStep, setConfirmStep] = useState<"signout" | "reset" | null>(null);
  const canSignOut = tailnetState?.loggedIn && !activeSessionLabel && onSignOut;
  const sessionVerb =
    sessionState === "live" ? "Connected to" : sessionState === "connecting" ? "Connecting to" : "Not connected to";
  let statusClass = "status-dot";
  // Signed out of Tailscale is a normal local-first state, not an error.
  let statusText = "Tailscale off · local network";

  if (activeSessionLabel) {
    statusClass += sessionState === "live"
      ? " status-dot--online"
      : sessionState === "connecting" ? " status-dot--connecting" : " status-dot--offline";
    statusText = `${sessionVerb} ${activeSessionLabel}`;
  } else if (tailnetState?.loggedIn) {
    statusClass += " status-dot--online";
    const expiry = describeKeyExpiry(tailnetState.keyExpiry);
    if (expiry.status === "expired") {
      statusClass += " status-dot--offline";
      statusText = "Tailscale key expired";
    } else if (expiry.status === "expiringSoon" && expiry.daysLeft !== null) {
      statusText = `Tailnet online · key expires in ${formatDaysLeft(expiry.daysLeft)}`;
    } else {
      statusText = "Tailnet online";
    }
  } else if (isRefreshing && !tailnetState) {
    // Only show syncing during initial bootstrap when we have no known state yet.
    statusClass += " status-dot--connecting";
    statusText = "Syncing tailnet...";
  } else {
    statusClass += " status-dot--offline";
  }

  return (
    <div className="sidebar-header">
      <div className="brand-row">
        <div className="brand-icon" aria-hidden="true">
          <img className="brand-logo" src="logo.svg" alt="" />
        </div>
        <h1 className="brand-name">NomadVNC</h1>
      </div>

      <div className="tailnet-status" title={tailnetState?.selfDeviceName ?? ""}>
        <span className={statusClass} />
        <span className="sidebar-status-text">
          {activeSessionLabel ? (
            <>
              {sessionVerb} <strong>{activeSessionLabel}</strong>
            </>
          ) : (
            statusText
          )}
        </span>
        {canSignOut && (
          confirmStep === "signout" ? (
            <span className="sidebar-signout-confirm">
              <button
                className="btn btn--danger btn--sm"
                onClick={() => {
                  setConfirmStep(null);
                  onSignOut?.();
                }}
                title="Confirm tailnet sign-out"
              >
                Out?
              </button>
              {onResetIdentity && (
                <button
                  className="btn btn--secondary btn--sm"
                  onClick={() => setConfirmStep("reset")}
                  title="Reset the tailnet device identity (registers as a new device)"
                >
                  Reset…
                </button>
              )}
              <button
                className="btn btn--secondary btn--sm"
                onClick={() => setConfirmStep(null)}
                title="Stay signed in"
              >
                No
              </button>
            </span>
          ) : confirmStep === "reset" ? (
            <span className="sidebar-signout-confirm">
              <span
                className="sidebar-reset-warning"
                title="Resetting wipes this device's tailnet identity and registers it as a brand-new device. The old device entry stays in the Tailscale admin console until removed there."
              >
                New identity?
              </span>
              <button
                className="btn btn--danger btn--sm"
                onClick={() => {
                  setConfirmStep(null);
                  onResetIdentity?.();
                }}
                title="Confirm tailnet identity reset"
              >
                Reset
              </button>
              <button
                className="btn btn--secondary btn--sm"
                onClick={() => setConfirmStep(null)}
                title="Keep the current identity"
              >
                No
              </button>
            </span>
          ) : (
            <button
              className="btn btn--secondary btn--sm"
              onClick={() => setConfirmStep("signout")}
              title={`Sign ${tailnetState?.selfDeviceName ? `${tailnetState.selfDeviceName} ` : ""}out of Tailscale (switch account)`}
            >
              Sign Out
            </button>
          )
        )}
      </div>
    </div>
  );
}
