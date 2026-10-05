import { useState } from "react";
import type { TailnetState } from "@nomadvnc/domain";
import { CloudIcon, MonitorIcon, PlusIcon, ShieldCheckIcon, WifiIcon } from "./icons";

interface ViewerPlaceholderProps {
  tailnetState: TailnetState | null;
  hasMachines: boolean;
  hasAccount?: boolean;
  sessionHint: string;
  isSigningIn: boolean;
  onSignIn: () => void;
  onOpenAccount?: () => void;
  onSelectLocalMode?: () => void;
  onAddMachine?: () => void;
  /** Opens Settings, where the remote-machine setup guides live. */
  onOpenSettings?: () => void;
  /** The add-machine form is already open in the sidebar (hide the duplicate CTA). */
  formOpen?: boolean;
}

const MODE_KEY = "nomadvnc_mode_chosen";
/** Set once the user skips the optional Tailscale step; it never nags again. */
const TAILSCALE_SKIPPED_KEY = "nomadvnc_tailscale_skipped";

function readFlag(key: string, value: string): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(key) === value;
  } catch {
    return false;
  }
}

function writeFlag(key: string, value: string | null): void {
  try {
    if (value === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, value);
    }
  } catch {
    // Storage is best-effort; the flow still works for this run.
  }
}

export function ViewerPlaceholder({
  tailnetState,
  hasMachines,
  hasAccount = false,
  sessionHint,
  isSigningIn,
  onSignIn,
  onOpenAccount,
  onSelectLocalMode,
  onAddMachine,
  onOpenSettings,
  formOpen = false,
}: ViewerPlaceholderProps) {
  const needsAuth = !tailnetState?.loggedIn;
  // The mode choice advances the flow to Step 2. "local" persists across
  // launches; "account" is session-only — it only sticks once sign-in
  // completes (hasAccount), so abandoning sign-in returns to Step 1.
  type ModeChoice = "account" | "local";
  const [modeChoice, setModeChoice] = useState<ModeChoice | null>(() =>
    readFlag(MODE_KEY, "local") ? "local" : null,
  );
  const [tailscaleSkipped, setTailscaleSkipped] = useState(() => readFlag(TAILSCALE_SKIPPED_KEY, "1"));

  // Step 2 is shown only after the user makes a selection (has an account, has saved machines, or picked a mode)
  const modeSelected = hasAccount || hasMachines || modeChoice !== null;
  // The optional Tailscale step is a one-time offer: once skipped, or once
  // the user has machines, the app shows its normal ready state with a
  // small sign-in nudge instead of re-pitching Tailscale every launch.
  const showStepOne = needsAuth && !modeSelected;
  const showStepTwo = needsAuth && modeSelected && !tailscaleSkipped && !hasMachines;

  function handleChooseLocal() {
    setModeChoice("local");
    writeFlag(MODE_KEY, "local");
    onSelectLocalMode?.();
  }

  function handleChooseAccount() {
    setModeChoice("account");
    onOpenAccount?.();
  }

  function handleChangeMode() {
    setModeChoice(null);
    writeFlag(MODE_KEY, null);
  }

  function handleSkipTailscale() {
    setTailscaleSkipped(true);
    writeFlag(TAILSCALE_SKIPPED_KEY, "1");
    onAddMachine?.();
  }

  const heading = showStepOne
    ? "Get Started with NomadVNC"
    : showStepTwo
      ? "Find Your Machines Automatically"
      : hasMachines
        ? "Ready to Connect"
        : "Set Up Your First Machine";

  const description = showStepOne
    ? "Remote desktop for any computer you have access to, at home or anywhere, with no port forwarding."
    : showStepTwo
      ? "Tailscale lists the computers you can reach and connects to them securely from anywhere. On your local network you can skip it and type an address."
      : hasMachines
        ? sessionHint
        : needsAuth
          ? "Add a machine by its IP address or hostname, then connect with one click."
          : "Pick a device from your tailnet (or type an address), then connect with one click.";

  return (
    <div className="viewer-placeholder">
      <div className="viewer-placeholder-icon">
        <MonitorIcon />
      </div>

      <h2>{heading}</h2>

      <p className="viewer-placeholder-desc">{description}</p>

      {showStepOne || showStepTwo ? (
        <div className="onboarding-flow">
          {showStepOne ? (
            /* Step 1: User ONLY sees Step 1 initially */
            <section className="onboarding-step-card">
              <div className="onboarding-step-card__badge">Step 1 of 2</div>
              <div className="onboarding-step-card__body">
                <h3 className="onboarding-step-card__title">
                  Where Should Your Machines Live?
                </h3>
                <p className="onboarding-step-card__desc">
                  Sync them across your devices with a free account, or keep them on this computer only. You can change this later.
                </p>

                <div className="onboarding-choice-grid">
                  <div className="onboarding-choice-card">
                    <div className="onboarding-choice-card__head">
                      <CloudIcon style={{ width: 18, height: 18, color: "var(--accent)" }} />
                      <span className="onboarding-choice-card__name">Nomad Account</span>
                      <span className="onboarding-pill onboarding-pill--recommended">Cloud Sync</span>
                    </div>
                    <p className="onboarding-choice-card__text">
                      Your machines, groups, and saved passwords follow you to every device. Sign in with an emailed link. There is no password to remember.
                    </p>
                    <button
                      type="button"
                      className="btn btn--primary btn--sm btn--full"
                      onClick={handleChooseAccount}
                    >
                      Create Account / Sign In
                    </button>
                  </div>

                  <div className="onboarding-choice-card">
                    <div className="onboarding-choice-card__head">
                      <MonitorIcon style={{ width: 18, height: 18, color: "var(--text-secondary)" }} />
                      <span className="onboarding-choice-card__name">Local Mode</span>
                      <span className="onboarding-pill">No Account</span>
                    </div>
                    <p className="onboarding-choice-card__text">
                      Everything stays on this computer. Passwords are kept in your system keychain.
                    </p>
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm btn--full"
                      onClick={handleChooseLocal}
                    >
                      Continue as Local User
                    </button>
                  </div>
                </div>
              </div>
            </section>
          ) : (
            /* Step 2: Comes in after selection */
            <section className="onboarding-step-card">
              <div className="onboarding-step-card__badge">Step 2 of 2 · Optional</div>
              <div className="onboarding-step-card__body">
                <h3 className="onboarding-step-card__title">
                  Sign In with Tailscale
                </h3>
                <p className="onboarding-step-card__desc">
                  Your browser opens to approve this computer on your tailnet. NomadVNC only uses it for its own connections, with no system-wide VPN.
                </p>

                <div className="onboarding-tailnet-actions">
                  <button
                    type="button"
                    className="btn btn--primary"
                    onClick={onSignIn}
                    disabled={isSigningIn}
                  >
                    {isSigningIn ? "Opening…" : "Sign In with Tailscale"}
                  </button>
                  {onAddMachine && (
                    <button
                      type="button"
                      className="btn btn--secondary"
                      onClick={handleSkipTailscale}
                    >
                      Enter an Address
                    </button>
                  )}
                </div>

                <div className="onboarding-features-row">
                  <span className="onboarding-feature-chip">
                    <WifiIcon style={{ width: 13, height: 13 }} />
                    No Port Forwarding
                  </span>
                  <span className="onboarding-feature-chip">
                    <ShieldCheckIcon style={{ width: 13, height: 13 }} />
                    Encrypted with WireGuard
                  </span>
                  <span className="onboarding-feature-chip">
                    <MonitorIcon style={{ width: 13, height: 13 }} />
                    Works from Anywhere
                  </span>
                </div>

                <div className="onboarding-back-row">
                  <button
                    type="button"
                    className="btn-link"
                    onClick={handleChangeMode}
                  >
                    ← Back
                  </button>
                </div>
              </div>
            </section>
          )}
        </div>
      ) : (
        /* Ready state (tailnet signed in, or local user past onboarding) */
        <div className="viewer-placeholder-ready">
          {!hasMachines ? (
            <div className="viewer-placeholder-empty">
              <div className="viewer-placeholder-steps">
                <div className="viewer-placeholder-step">
                  <span className="viewer-placeholder-step-num">1</span>
                  <span className="viewer-placeholder-step-text">
                    {needsAuth ? "Enter the Machine's Address" : "Pick a Device or Enter an Address"}
                  </span>
                </div>
                <div className="viewer-placeholder-step">
                  <span className="viewer-placeholder-step-num">2</span>
                  <span className="viewer-placeholder-step-text">Add Its VNC Port & Password</span>
                </div>
                <div className="viewer-placeholder-step">
                  <span className="viewer-placeholder-step-num">3</span>
                  <span className="viewer-placeholder-step-text">Save It, Then Connect</span>
                </div>
              </div>

              {onAddMachine && !formOpen && (
                <button type="button" className="btn btn--primary" onClick={onAddMachine}>
                  <PlusIcon style={{ width: 16, height: 16 }} />
                  Add Your First Machine
                </button>
              )}

              <p className="viewer-placeholder-companion-hint">
                Works with optional NomadVNC Host on Windows, macOS Screen Sharing, and a standard VNC server on Linux. Any VPN that can reach the computer works.
                {onOpenSettings && (
                  <>
                    {" "}
                    <button type="button" className="btn-link" onClick={onOpenSettings}>
                      Setup guides in Settings
                    </button>
                  </>
                )}
              </p>
            </div>
          ) : (
            <div className="viewer-placeholder-steps">
              <div className="viewer-placeholder-step">
                <span className="viewer-placeholder-step-num">1</span>
                <span className="viewer-placeholder-step-text">Pick a Saved Machine</span>
              </div>
              <div className="viewer-placeholder-step">
                <span className="viewer-placeholder-step-num">2</span>
                <span className="viewer-placeholder-step-text">Click Connect</span>
              </div>
              <div className="viewer-placeholder-step">
                <span className="viewer-placeholder-step-num">3</span>
                <span className="viewer-placeholder-step-text">You&apos;re on Its Desktop</span>
              </div>
            </div>
          )}

          {needsAuth && (
            <div className="viewer-placeholder-tailnet-nudge">
              <span>Want NomadVNC to find your machines and reach them from anywhere?</span>
              <button type="button" className="btn btn--secondary btn--sm" onClick={onSignIn} disabled={isSigningIn}>
                {isSigningIn ? "Opening…" : "Sign In with Tailscale"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
