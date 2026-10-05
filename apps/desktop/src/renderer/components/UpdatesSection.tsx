import { useCallback, useEffect, useState } from "react";
import type { UpdatePrefs, UpdateStatus } from "@nomadvnc/platform-contracts";

function hasUpdatesApi(): boolean {
  const native = (window as unknown as { nomadNative?: unknown }).nomadNative as
    | Record<string, unknown>
    | undefined;
  return typeof native?.getUpdateStatus === "function";
}

function formatCheckedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString();
}

export function UpdatesSection() {
  const [supported] = useState(hasUpdatesApi);
  const [version, setVersion] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<UpdatePrefs | null>(null);
  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });
  const [busy, setBusy] = useState(false);
  const [canUninstall, setCanUninstall] = useState(false);
  const [confirmUninstall, setConfirmUninstall] = useState(false);

  useEffect(() => {
    if (!supported) {
      return;
    }
    let cancelled = false;
    const native = window.nomadNative;
    void native
      .getAppVersion()
      .then((v) => {
        if (!cancelled) {
          setVersion(v);
        }
      })
      .catch(() => {});
    void native
      .getUpdatePrefs()
      .then((p) => {
        if (!cancelled) {
          setPrefs(p);
        }
      })
      .catch(() => {});
    void native
      .getUpdateStatus()
      .then((s) => {
        if (!cancelled) {
          setStatus(s);
        }
      })
      .catch(() => {});
    if (typeof native.getWindowsInstall === "function") {
      void native
        .getWindowsInstall()
        .then((info) => {
          if (!cancelled) {
            setCanUninstall(info !== null);
          }
        })
        .catch(() => {});
    }
    const unsubscribe = native.onUpdateStatus((s) => {
      if (!cancelled) {
        setStatus(s);
        if (s.state !== "checking" && s.state !== "downloading") {
          setBusy(false);
        }
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [supported]);

  const handlePrefsChange = useCallback(
    async (next: UpdatePrefs) => {
      setPrefs(next);
      try {
        const saved = await window.nomadNative.setUpdatePrefs(next);
        setPrefs(saved);
      } catch {
        // Revert on failure; the main process keeps the source of truth.
        try {
          setPrefs(await window.nomadNative.getUpdatePrefs());
        } catch {
          // Leave the optimistic value; next mount re-reads.
        }
      }
    },
    [],
  );

  const handleCheck = useCallback(async () => {
    setBusy(true);
    try {
      setStatus(await window.nomadNative.checkForUpdates());
    } catch {
      setBusy(false);
    }
  }, []);

  const handleInstall = useCallback(async () => {
    try {
      await window.nomadNative.installUpdate();
    } catch {
      // installUpdate only rejects on IPC failure; install errors arrive
      // as an error status through the subscription.
    }
  }, []);

  const handleUninstall = useCallback(async () => {
    if (typeof window.nomadNative.uninstallWindowsApp !== "function") {
      return;
    }
    try {
      await window.nomadNative.uninstallWindowsApp();
    } catch {
      setConfirmUninstall(false);
    }
  }, []);

  if (!supported) {
    return null;
  }

  const checking = status.state === "checking" || busy;
  const canCheck = prefs?.enabled !== false && !checking && status.state !== "downloading";

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">Updates</h3>
      <p className="settings-storage-line">
        NomadVNC {version ? `v${version}` : ""} ·{" "}
        <a href="https://github.com/grpace/NomadVNC" target="_blank" rel="noreferrer">
          Source
        </a>{" "}
        ·{" "}
        <a href="https://github.com/grpace/NomadVNC/blob/master/THIRD_PARTY_NOTICES.md" target="_blank" rel="noreferrer">
          Open-Source Licenses
        </a>{" "}
        ·{" "}
        <a href="https://greg.tech/nomadvnc/privacy" target="_blank" rel="noreferrer">
          Privacy Policy
        </a>
      </p>

      {prefs ? (
        <label className="settings-check">
          <input
            type="checkbox"
            checked={prefs.enabled && prefs.autoCheck}
            onChange={(event) =>
              void handlePrefsChange({ enabled: true, autoCheck: event.target.checked })
            }
          />
          Automatically Check for Updates
        </label>
      ) : (
        <p className="form-hint">Loading update settings…</p>
      )}
      {prefs && !prefs.enabled && (
        <p className="form-hint">Updates are disabled.</p>
      )}

      <div className="settings-restart-row">
        <button className="btn btn--sm" onClick={() => void handleCheck()} disabled={!canCheck}>
          {checking ? "Checking…" : "Check for Updates"}
        </button>
        {status.state === "ready" && (
          <button className="btn btn--primary btn--sm" onClick={() => void handleInstall()}>
            Restart and Install{status.version ? ` v${status.version}` : ""}
          </button>
        )}
      </div>

      <UpdateStatusLine status={status} />

      <p className="form-hint settings-update-hint">
        Updates download in the background and install when you restart. On
        Linux, .deb/.rpm installs may ask for administrator privileges; macOS
        builds that aren't code-signed must be updated by downloading the new
        version.
      </p>

      {canUninstall && (
        <div className="settings-restart-row">
          {confirmUninstall ? (
            <>
              <p className="form-hint">
                This closes NomadVNC and opens the Windows uninstaller. You can choose there whether to delete saved machines.
              </p>
              <button className="btn btn--danger btn--sm" onClick={() => void handleUninstall()}>
                Uninstall NomadVNC
              </button>
              <button className="btn btn--sm" onClick={() => setConfirmUninstall(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button className="btn btn--sm" onClick={() => setConfirmUninstall(true)}>
              Uninstall
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function UpdateStatusLine({ status }: { status: UpdateStatus }) {
  switch (status.state) {
    case "idle":
      return null;
    case "checking":
      return <p className="form-hint">Checking for updates…</p>;
    case "not-available":
      return (
        <p className="form-hint">
          {status.message ?? "You're up to date."}
          {status.lastChecked ? ` Last checked ${formatCheckedAt(status.lastChecked)}.` : ""}
        </p>
      );
    case "available":
      return (
        <p className="form-hint">
          Update available{status.version ? `: v${status.version}` : ""}. Downloading in
          the background…
          {status.message ? ` ${status.message}` : ""}
        </p>
      );
    case "downloading":
      return (
        <div className="update-progress">
          <p className="form-hint">
            Downloading{status.version ? ` v${status.version}` : ""}…
            {typeof status.percent === "number" ? ` ${status.percent}%` : ""}
          </p>
          {typeof status.percent === "number" && (
            <div className="update-progress-track">
              <div
                className="update-progress-fill"
                style={{ width: `${Math.min(100, Math.max(0, status.percent))}%` }}
              />
            </div>
          )}
        </div>
      );
    case "ready":
      return (
        <p className="form-hint">
          Update{status.version ? ` v${status.version}` : ""} downloaded. Restart to
          install it.
        </p>
      );
    case "error":
      return (
        <p className="form-error">
          {status.message ?? "Update check failed."}
          {status.manualDownloadUrl && (
            <>
              {" "}
              <a href={status.manualDownloadUrl} target="_blank" rel="noreferrer">
                Download{status.version ? ` v${status.version}` : " the latest version"}
              </a>
            </>
          )}
        </p>
      );
  }
}
