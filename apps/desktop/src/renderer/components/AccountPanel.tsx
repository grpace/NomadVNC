import { useState, type FormEvent, type KeyboardEvent } from "react";
import { isValidAccountBaseUrl } from "../accountConfig";
import { extractMagicToken, type AccountSession } from "../accountSession";
import { MailIcon, RefreshIcon } from "./icons";

interface AccountPanelProps {
  session: AccountSession | null;
  baseUrl: string;
  lastSyncAt: string | null;
  /** Local machines that will upload on the next sign-in (signed-out only). */
  pendingUploadCount: number;
  /** Account email those pending uploads belong to (signed-out only). */
  pendingUploadEmail: string | null;
  onBaseUrlChange: (baseUrl: string) => void;
  onRequestLink: (email: string) => Promise<void>;
  onConsumeLink: (token: string) => Promise<void>;
  onSignOut: () => Promise<void>;
  /** Permanently deletes the account on the server. */
  onDeleteAccount: () => Promise<void>;
  onSyncNow: () => Promise<void>;
  onNotice: (message: string, variant: "info" | "success" | "error") => void;
}

export function AccountPanel({
  session,
  baseUrl,
  lastSyncAt,
  pendingUploadCount,
  pendingUploadEmail,
  onBaseUrlChange,
  onRequestLink,
  onConsumeLink,
  onSignOut,
  onDeleteAccount,
  onSyncNow,
  onNotice,
}: AccountPanelProps) {
  const [serverDraft, setServerDraft] = useState(baseUrl);
  const [email, setEmail] = useState("");
  const [linkInput, setLinkInput] = useState("");
  const [busy, setBusy] = useState<"idle" | "request" | "consume" | "signout" | "sync" | "delete">("idle");
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  async function run(
    kind: "request" | "consume" | "signout" | "sync" | "delete",
    task: () => Promise<void>,
  ): Promise<void> {
    setBusy(kind);
    try {
      await task();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Account request failed", "error");
    } finally {
      setBusy("idle");
    }
  }

  function saveServer(): void {
    if (!isValidAccountBaseUrl(serverDraft)) {
      onNotice("Server address must look like http(s)://host[:port]", "error");
      return;
    }
    onBaseUrlChange(serverDraft.trim().replace(/\/+$/, ""));
  }

  function saveServerOnEnter(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter") {
      event.preventDefault();
      saveServer();
    }
  }

  function requestLink(): void {
    if (busy !== "idle" || email.trim() === "") {
      return;
    }
    void run("request", async () => {
      await onRequestLink(email.trim());
      onNotice("Sign-in link sent. Check your email and click the link. NomadVNC will sign you in automatically.", "success");
    });
  }

  function consumeLink(): void {
    if (busy !== "idle" || linkInput.trim() === "") {
      return;
    }
    void run("consume", async () => {
      const token = extractMagicToken(linkInput);
      if (!token) {
        onNotice("That doesn't look like a sign-in link or token.", "error");
        return;
      }
      await onConsumeLink(token);
      setLinkInput("");
    });
  }

  function submitRequest(event: FormEvent): void {
    event.preventDefault();
    requestLink();
  }

  function submitLink(event: FormEvent): void {
    event.preventDefault();
    consumeLink();
  }

  if (session) {
    return (
      <div className="account-panel">
        <div className="account-panel__header">
          <div className="account-panel__title-row">
            <h2 className="section-title">Nomad Account</h2>
            <span className={`account-badge ${lastSyncAt ? "account-badge--active" : "account-badge--local"}`}>
              <span className={`status-dot ${lastSyncAt ? "status-dot--online" : "status-dot--offline"}`} />
              {lastSyncAt ? "Synced" : "Connected"}
            </span>
          </div>
          <p className="account-panel__subtext">
            Machines and preferences sync securely with your Nomad account.
          </p>
        </div>

        <div className="account-card account-identity-card">
          <div className="account-identity">
            <span className="account-identity__avatar" aria-hidden="true">
              {session.email.charAt(0).toUpperCase()}
            </span>
            <div className="account-identity__meta">
              <div className="account-identity__email-row">
                <span className="account-identity__email">{session.email}</span>
                <span className="account-verified-pill" title="Verified Account">✓</span>
              </div>
              <span className="account-identity__status">
                {lastSyncAt
                  ? `Last synced ${new Date(lastSyncAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                  : "Not synced yet"}
              </span>
            </div>
          </div>

          <div className="btn-stack account-actions">
            <button
              type="button"
              className="btn btn--primary btn--full"
              disabled={busy !== "idle"}
              onClick={() => void run("sync", onSyncNow)}
            >
              <RefreshIcon style={{ width: 14, height: 14, animation: busy === "sync" ? "spin 1s linear infinite" : "none" }} />
              {busy === "sync" ? "Syncing…" : "Sync Now"}
            </button>
            <button
              type="button"
              className="btn btn--secondary btn--full"
              disabled={busy !== "idle"}
              onClick={() => void run("signout", onSignOut)}
            >
              {busy === "signout" ? "Signing Out…" : "Sign Out of Nomad Account"}
            </button>
          </div>
        </div>

        <details className="account-advanced" onToggle={() => setConfirmingDelete(false)}>
          <summary className="account-advanced__summary">Delete Account</summary>
          <div className="account-advanced__content">
            <p className="form-hint">
              Permanently deletes your Nomad account and everything synced to it: machines, saved
              passwords, and shares. Machines saved on this computer are kept. This can&apos;t be undone.
            </p>
            {confirmingDelete ? (
              <div className="btn-stack">
                <button
                  type="button"
                  className="btn btn--danger btn--full"
                  disabled={busy !== "idle"}
                  onClick={() => void run("delete", onDeleteAccount)}
                >
                  {busy === "delete" ? "Deleting…" : `Permanently Delete ${session.email}`}
                </button>
                <button
                  type="button"
                  className="btn btn--secondary btn--full"
                  disabled={busy !== "idle"}
                  onClick={() => setConfirmingDelete(false)}
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn--secondary btn--full"
                disabled={busy !== "idle"}
                onClick={() => setConfirmingDelete(true)}
              >
                Delete Account…
              </button>
            )}
          </div>
        </details>

        <details className="account-advanced">
          <summary className="account-advanced__summary">
            Server Endpoint
          </summary>
          <div className="account-advanced__content">
            <div className="form-group">
              <label className="form-label" htmlFor="account-server">Account Server</label>
              <input
                id="account-server"
                className="form-input"
                value={serverDraft}
                onChange={(event) => setServerDraft(event.target.value)}
                onBlur={saveServer}
                onKeyDown={saveServerOnEnter}
                spellCheck={false}
              />
              <p className="form-hint">Address of your self-hosted or cloud Nomad service.</p>
            </div>
          </div>
        </details>
      </div>
    );
  }

  return (
    <div className="account-panel">
      <div className="account-panel__header">
        <div className="account-panel__title-row">
          <h2 className="section-title">Nomad Account</h2>
          <span className="account-badge account-badge--local">Local Mode</span>
        </div>
        <p className="account-panel__subtext">
          Optional. Connect an account to sync your saved machines and settings across devices.
        </p>
      </div>

      {pendingUploadCount > 0 && pendingUploadEmail && (
        <div className="account-notice account-notice--warning" data-testid="account-pending-uploads">
          <p className="form-hint account-pending">
            {pendingUploadCount} local machine{pendingUploadCount === 1 ? "" : "s"} waiting
            to upload. Sign in as {pendingUploadEmail} to sync{" "}
            {pendingUploadCount === 1 ? "it" : "them"} to your account.
          </p>
        </div>
      )}

      <div className="account-card">
        <div className="account-card__header">
          <div className="account-card__icon">
            <MailIcon style={{ width: 16, height: 16 }} />
          </div>
          <span className="account-card__title">Sign In with Magic Link</span>
        </div>

        <form className="account-form" onSubmit={submitRequest}>
          <div className="form-group">
            <label className="form-label" htmlFor="account-email">Email</label>
            <input
              id="account-email"
              className="form-input"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              autoComplete="email"
              spellCheck={false}
              enterKeyHint="send"
            />
          </div>

          <div className="btn-stack">
            <button
              type="submit"
              className="btn btn--primary btn--full"
              disabled={busy !== "idle" || email.trim() === ""}
            >
              {busy === "request" ? "Sending…" : "Email Me a Sign-In Link"}
            </button>
          </div>
        </form>

        <div className="account-divider">
          <span>Or Paste the Link</span>
        </div>

        <form className="account-form" onSubmit={submitLink}>
          <div className="form-group">
            <label className="form-label" htmlFor="account-link">Paste Sign-In Link</label>
            <input
              id="account-link"
              className="form-input"
              value={linkInput}
              onChange={(event) => setLinkInput(event.target.value)}
              placeholder="nomadvnc://auth/callback?token=…"
              spellCheck={false}
              enterKeyHint="go"
            />
            <p className="form-hint">Fallback for when the email link doesn't open the app. Paste the whole link here.</p>
          </div>

          <div className="btn-stack">
            <button
              type="submit"
              className="btn btn--secondary btn--full"
              disabled={busy !== "idle" || linkInput.trim() === ""}
            >
              {busy === "consume" ? "Signing In…" : "Sign In with This Link"}
            </button>
          </div>
        </form>
      </div>

      <details className="account-advanced">
        <summary className="account-advanced__summary">
          Advanced Server Settings
        </summary>
        <div className="account-advanced__content">
          <div className="form-group">
            <label className="form-label" htmlFor="account-server">Account Server</label>
            <input
              id="account-server"
              className="form-input"
              value={serverDraft}
              onChange={(event) => setServerDraft(event.target.value)}
              onBlur={saveServer}
              onKeyDown={saveServerOnEnter}
              placeholder="http://localhost:3200"
              spellCheck={false}
            />
            <p className="form-hint">Address of your self-hosted or cloud Nomad service.</p>
          </div>
        </div>
      </details>
    </div>
  );
}
