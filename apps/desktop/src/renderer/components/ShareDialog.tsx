import { useEffect, useState, type FormEvent } from "react";
import type { BackendShareView, ShareGrantInput } from "../accountClient";

interface ShareDialogProps {
  machineLabel: string;
  shares: BackendShareView[];
  loadingShares: boolean;
  onGrant: (input: ShareGrantInput) => Promise<{ inviteSent: boolean }>;
  onRekey: (shareId: string, key: string, expiresAtIso: string) => Promise<void>;
  onClearKey: (shareId: string) => Promise<void>;
  onRevoke: (shareId: string) => Promise<void>;
  onNotice: (message: string, variant: "info" | "success" | "error") => void;
  onClose: () => void;
}

const WARN_WITHIN_DAYS = 7;
const MAX_KEY_DAYS = 90;

function expiryLabel(share: BackendShareView): { text: string; tone: "ok" | "warn" | "bad" | "plain" } {
  if (!share.hasTailnetKey) {
    return { text: "Same-tailnet · never expires", tone: "plain" };
  }
  const days = share.keyExpiresInDays;
  if (days === null) {
    return { text: "Tailnet key attached", tone: "ok" };
  }
  if (days <= 0) {
    return { text: "Tailnet key expired. Replace it before the grantee is locked out", tone: "bad" };
  }
  if (days <= WARN_WITHIN_DAYS) {
    return { text: `Tailnet key expires in ${days}d. Replace soon`, tone: "warn" };
  }
  return { text: `Tailnet key expires in ${days}d`, tone: "ok" };
}

function daysToIso(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

export function ShareDialog({
  machineLabel,
  shares,
  loadingShares,
  onGrant,
  onRekey,
  onClearKey,
  onRevoke,
  onNotice,
  onClose,
}: ShareDialogProps) {
  const [email, setEmail] = useState("");
  const [includeKey, setIncludeKey] = useState(true);
  const [keyInput, setKeyInput] = useState("");
  const [daysInput, setDaysInput] = useState("30");
  const [rekeyingId, setRekeyingId] = useState<string | null>(null);
  const [rekeyKey, setRekeyKey] = useState("");
  const [rekeyDays, setRekeyDays] = useState("30");
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function run(key: string, task: () => Promise<void>): Promise<void> {
    setBusy(key);
    try {
      await task();
    } catch (error) {
      onNotice(error instanceof Error ? error.message : "Share request failed", "error");
    } finally {
      setBusy(null);
    }
  }

  function parseDays(raw: string): number | null {
    const days = Number(raw);
    if (!Number.isInteger(days) || days < 1 || days > MAX_KEY_DAYS) {
      return null;
    }
    return days;
  }

  function submitGrant(event: FormEvent): void {
    event.preventDefault();
    handleGrant();
  }

  function submitRekey(event: FormEvent, shareId: string): void {
    event.preventDefault();
    handleRekey(shareId);
  }

  function handleGrant(): void {
    const address = email.trim();
    if (address === "") {
      onNotice("Enter the email address to share with.", "error");
      return;
    }
    let input: ShareGrantInput = { email: address };
    if (includeKey) {
      const key = keyInput.trim();
      if (key === "") {
        onNotice("Paste the Tailscale auth key, or untick key-passing for same-tailnet sharing.", "error");
        return;
      }
      const days = parseDays(daysInput);
      if (days === null) {
        onNotice(`Key expiry must be 1–${MAX_KEY_DAYS} days.`, "error");
        return;
      }
      input = { email: address, tailnetAuthKey: key, keyExpiresAt: daysToIso(days) };
    }
    void run("grant", async () => {
      const { inviteSent } = await onGrant(input);
      setEmail("");
      setKeyInput("");
      onNotice(
        inviteSent
          ? `Shared with ${address}. Invite emailed.`
          : `Shared with ${address}. Mail isn't configured, so tell them yourself.`,
        "success",
      );
    });
  }

  function handleRekey(shareId: string): void {
    const key = rekeyKey.trim();
    if (key === "") {
      onNotice("Paste the fresh Tailscale auth key.", "error");
      return;
    }
    const days = parseDays(rekeyDays);
    if (days === null) {
      onNotice(`Key expiry must be 1–${MAX_KEY_DAYS} days.`, "error");
      return;
    }
    void run(`rekey:${shareId}`, async () => {
      await onRekey(shareId, key, daysToIso(days));
      setRekeyingId(null);
      setRekeyKey("");
      onNotice("Tailnet key replaced. No re-invite needed.", "success");
    });
  }

  const busyAny = busy !== null;

  return (
    <div className="password-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="password-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-dialog-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="share-dialog-title" className="password-modal__title">
          Share &ldquo;{machineLabel}&rdquo;
        </h2>
        <p className="password-modal__body">
          Grants stay live until revoked. The key is the grantee's connect
          credential for this device, but they must already be on your tailnet
          (for example, your company Tailscale). The key alone doesn't grant
          tailnet access. Same-tailnet shares need no key and never expire. We never proxy
          VNC.
        </p>

        {loadingShares ? (
          <p className="form-hint">Loading grants…</p>
        ) : shares.length === 0 ? (
          <p className="form-hint">Not shared with anyone yet.</p>
        ) : (
          <ul className="share-list">
            {shares.map((share) => {
              const expiry = expiryLabel(share);
              const expanded = rekeyingId === share.id;
              return (
                <li key={share.id} className="share-row">
                  <div className="share-row__main">
                    <strong>{share.granteeEmail}</strong>
                    <span className={`share-expiry share-expiry--${expiry.tone}`}>{expiry.text}</span>
                  </div>
                  <div className="share-row__actions">
                    {share.hasTailnetKey && !expanded && (
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        disabled={busyAny}
                        onClick={() => {
                          setRekeyingId(share.id);
                          setRekeyKey("");
                          setRekeyDays("30");
                        }}
                      >
                        Replace Key
                      </button>
                    )}
                    {confirmRevokeId === share.id ? (
                      <>
                        <button
                          type="button"
                          className="btn btn--danger btn--sm"
                          disabled={busyAny}
                          onClick={() =>
                            void run(`revoke:${share.id}`, async () => {
                              await onRevoke(share.id);
                              setConfirmRevokeId(null);
                              onNotice(`Sharing with ${share.granteeEmail} revoked.`, "info");
                            })
                          }
                        >
                          {busy === `revoke:${share.id}` ? "Revoking…" : "Confirm"}
                        </button>
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          disabled={busyAny}
                          onClick={() => setConfirmRevokeId(null)}
                        >
                          Keep
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        disabled={busyAny}
                        onClick={() => setConfirmRevokeId(share.id)}
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                  {expanded && (
                    <form className="share-rekey" onSubmit={(event) => submitRekey(event, share.id)}>
                      <input
                        className="form-input"
                        value={rekeyKey}
                        onChange={(e) => setRekeyKey(e.target.value)}
                        placeholder="Paste the fresh Tailscale auth key"
                        spellCheck={false}
                        aria-label="Fresh Tailscale auth key"
                      />
                      <input
                        className="form-input share-days"
                        value={rekeyDays}
                        onChange={(e) => setRekeyDays(e.target.value)}
                        inputMode="numeric"
                        aria-label="Key expiry in days"
                      />
                      <div className="btn-row">
                        <button
                          type="submit"
                          className="btn btn--primary btn--sm"
                          disabled={busyAny}
                        >
                          {busy === `rekey:${share.id}` ? "Saving…" : "Save Key"}
                        </button>
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          disabled={busyAny}
                          onClick={() => setRekeyingId(null)}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          disabled={busyAny}
                          title="Drop the key; the grant becomes same-tailnet only"
                          onClick={() =>
                            void run(`clear:${share.id}`, async () => {
                              await onClearKey(share.id);
                              setRekeyingId(null);
                              onNotice("Key removed. The grant is same-tailnet only now.", "info");
                            })
                          }
                        >
                          Remove Key
                        </button>
                      </div>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        <form className="share-grant" onSubmit={submitGrant}>
        <div className="form-group">
          <label className="form-label" htmlFor="share-email">Share With</label>
          <input
            id="share-email"
            className="form-input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="friend@example.com"
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <label className="form-checkbox" htmlFor="share-include-key">
          <input
            id="share-include-key"
            type="checkbox"
            checked={includeKey}
            onChange={(e) => setIncludeKey(e.target.checked)}
          />
          <span className="form-checkbox-label">
            <span className="form-checkbox-title">Attach Tailnet Auth Key</span>
            <span className="form-checkbox-hint">
              Mint a reusable, ephemeral, tagged key in Tailscale admin (7–30d) and paste it as
              their connect credential. They must already be on your tailnet. The key
              doesn't grant tailnet access by itself. Untick for same-tailnet sharing.
            </span>
          </span>
        </label>
        {includeKey && (
          <div className="form-group">
            <label className="form-label" htmlFor="share-key">Tailscale Auth Key</label>
            <input
              id="share-key"
              className="form-input"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="tskey-auth-…"
              autoComplete="off"
              spellCheck={false}
            />
            <label className="form-label" htmlFor="share-days">Key Expiry (Days)</label>
            <input
              id="share-days"
              className="form-input share-days"
              value={daysInput}
              onChange={(e) => setDaysInput(e.target.value)}
              inputMode="numeric"
            />
          </div>
        )}
        <div className="password-modal__actions">
          <button type="button" className="btn btn--secondary" onClick={onClose} disabled={busyAny}>
            Close
          </button>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={busyAny || email.trim() === ""}
          >
            {busy === "grant" ? "Sharing…" : "Share"}
          </button>
        </div>
        </form>
      </div>
    </div>
  );
}
