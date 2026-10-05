import { useEffect, useState } from "react";
import type { NativeFrameConfig, SecureStorageStatus, TailscaleHostnameResult } from "@nomadvnc/platform-contracts";
import type { AppSettings } from "../appSettings";
import { MonitorIcon, ServerIcon, ShieldCheckIcon, SlidersIcon } from "./icons";
import { UpdatesSection } from "./UpdatesSection";
import { HeadlessSetup } from "./HeadlessSetup";
import { WindowsPcSetup } from "./WindowsPcSetup";

interface SettingsPanelProps {
  settings: AppSettings;
  secureStorage: SecureStorageStatus | null;
  onChange: (partial: Partial<AppSettings>) => void;
  nativeFrame: NativeFrameConfig | null;
  nativeFrameNeedsRestart: boolean;
  onNativeFrameChange: (enabled: boolean) => void;
  onRelaunch: () => void;
  /** Persists the tailnet name. Empty restores the automatic name. */
  onTailscaleHostname: (name: string) => Promise<TailscaleHostnameResult>;
}

const SCALE_OPTIONS = [
  { value: "fit", label: "Fit Window" },
  { value: "actual", label: "Actual Size" },
  { value: "zoom", label: "Zoom" },
] as const;

const QUALITY_OPTIONS = [
  { value: 6, label: "Auto (Balanced)" },
  { value: 2, label: "Low" },
  { value: 5, label: "Medium" },
  { value: 8, label: "High" },
  { value: 9, label: "Lossless" },
] as const;

export function SettingsPanel({
  settings,
  secureStorage,
  onChange,
  nativeFrame,
  nativeFrameNeedsRestart,
  onNativeFrameChange,
  onRelaunch,
  onTailscaleHostname,
}: SettingsPanelProps) {
  const [nameDraft, setNameDraft] = useState(settings.tailscaleHostname);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameStatus, setNameStatus] = useState<string | null>(null);
  const [nameBusy, setNameBusy] = useState(false);
  const nameDirty = nameDraft.trim() !== settings.tailscaleHostname;
  useEffect(() => {
    setNameDraft(settings.tailscaleHostname);
  }, [settings.tailscaleHostname]);

  async function commitTailscaleName(): Promise<void> {
    if (nameBusy || nameDraft.trim() === settings.tailscaleHostname) return;
    setNameBusy(true);
    setNameError(null);
    setNameStatus(null);
    try {
      const result = await onTailscaleHostname(nameDraft);
      const typed = nameDraft.trim();
      if (typed === "") {
        setNameStatus(`Using the automatic name, ${result.hostname}.`);
      } else if (result.applied) {
        setNameDraft(result.hostname);
        setNameStatus(`Updated on your tailnet as ${result.hostname}.`);
      } else {
        setNameDraft(result.hostname);
        setNameStatus(`Saved as ${result.hostname}. Used the next time you sign in to Tailscale.`);
      }
    } catch (err) {
      setNameError(err instanceof Error ? err.message : "Couldn't save the Tailscale name");
    } finally {
      setNameBusy(false);
    }
  }

  return (
    <div className="settings-panel">
      <div className="settings-panel__header">
        <h2 className="section-title">Settings</h2>
        <p className="settings-panel__subtext">
          App-wide defaults for new machines and remote sessions. Per-machine preferences are preserved.
        </p>
      </div>

      <div className="settings-card">
        <div className="settings-card__header">
          <div className="settings-card__icon">
            <ServerIcon style={{ width: 16, height: 16 }} />
          </div>
          <h3 className="settings-section-title">This Computer</h3>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="settings-tailscale-name">
            Tailscale Name
          </label>
          <input
            id="settings-tailscale-name"
            className="form-input"
            value={nameDraft}
            placeholder="NomadVNC and this computer's name"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            onChange={(event) => {
              setNameDraft(event.target.value);
              setNameStatus(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void commitTailscaleName();
              }
            }}
          />
          <p className="form-hint">
            The name this computer uses on your tailnet. Leave blank to use NomadVNC plus the computer name. Click Save Name to apply it. That does not sign you in. If Tailscale is already connected, the name updates then.
          </p>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={!nameDirty || nameBusy}
            onClick={() => void commitTailscaleName()}
          >
            {nameBusy ? "Saving…" : "Save Name"}
          </button>
          {nameError && <p className="form-error">{nameError}</p>}
          {nameStatus && !nameError && <p className="form-hint">{nameStatus}</p>}
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card__header">
          <div className="settings-card__icon">
            <MonitorIcon style={{ width: 16, height: 16 }} />
          </div>
          <h3 className="settings-section-title">Viewer Defaults</h3>
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="settings-scale">
            Scale Mode
          </label>
          <div className="settings-select-wrapper">
            <select
              id="settings-scale"
              className="form-select"
              value={settings.defaultScaleMode}
              onChange={(event) =>
                onChange({ defaultScaleMode: event.target.value as AppSettings["defaultScaleMode"] })
              }
            >
              {SCALE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="settings-quality">
            Quality
          </label>
          <div className="settings-select-wrapper">
            <select
              id="settings-quality"
              className="form-select"
              value={settings.defaultQuality}
              onChange={(event) => onChange({ defaultQuality: Number(event.target.value) })}
            >
              {QUALITY_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <label className="settings-check">
          <input
            type="checkbox"
            checked={settings.defaultAutoQuality}
            onChange={(event) => onChange({ defaultAutoQuality: event.target.checked })}
          />
          <span className="settings-check__text">Auto Quality on Slow Connections</span>
        </label>

        <label className="settings-check">
          <input
            type="checkbox"
            checked={settings.defaultCaptureKeys}
            onChange={(event) => onChange({ defaultCaptureKeys: event.target.checked })}
          />
          <span className="settings-check__text">Grab Keyboard (Super / Alt-Tab) by Default</span>
        </label>
      </div>

      <div className="settings-card">
        <div className="settings-card__header">
          <div className="settings-card__icon">
            <SlidersIcon style={{ width: 16, height: 16 }} />
          </div>
          <h3 className="settings-section-title">New Machines</h3>
        </div>

        <div className="form-group">
          <label className="form-label" htmlFor="settings-default-port">
            Default VNC Port
          </label>
          <input
            id="settings-default-port"
            className="form-input"
            type="number"
            min={1}
            max={65535}
            value={settings.defaultVncPort}
            onChange={(event) => {
              const port = Number(event.target.value);
              if (Number.isInteger(port) && port >= 1 && port <= 65535) {
                onChange({ defaultVncPort: port });
              }
            }}
          />
          <p className="form-hint">Prefilled automatically when configuring a new machine.</p>
        </div>
      </div>

      <div className="settings-card">
        <div className="settings-card__header">
          <div className="settings-card__icon">
            <ShieldCheckIcon style={{ width: 16, height: 16 }} />
          </div>
          <h3 className="settings-section-title">Password Storage</h3>
        </div>

        {secureStorage ? (
          <div className="settings-storage-box">
            <div className="settings-storage-line">
              <span
                className={`status-dot ${secureStorage.available ? "status-dot--online" : "status-dot--offline"}`}
              />
              <span className="settings-storage-status">
                {secureStorage.available ? (
                  <>
                    Available{secureStorage.backend ? ` (${secureStorage.backend})` : ""}. Saved
                    passwords use your OS keyring.
                  </>
                ) : (
                  <>Unavailable. Passwords are kept for this session only.</>
                )}
              </span>
            </div>
            {secureStorage.hint && <p className="form-hint">{secureStorage.hint}</p>}
          </div>
        ) : (
          <p className="form-hint">Checking OS keyring…</p>
        )}
      </div>

      <div className="settings-card">
        <div className="settings-card__header">
          <div className="settings-card__icon">
            <MonitorIcon style={{ width: 16, height: 16 }} />
          </div>
          <h3 className="settings-section-title">Window</h3>
        </div>

        {nativeFrame ? (
          <>
            <label className="settings-check">
              <input
                type="checkbox"
                checked={nativeFrame.enabled}
                disabled={nativeFrame.managedByEnv}
                onChange={(event) => onNativeFrameChange(event.target.checked)}
              />
              <span className="settings-check__text">Use Native Window Frame</span>
            </label>
            <p className="form-hint">
              Recommended for tiling window managers (i3, Sway, Hyprland) where custom frameless windows misbehave.
            </p>
            {nativeFrame.managedByEnv && (
              <p className="form-hint">Controlled by NOMADVNC_NATIVE_FRAME environment variable.</p>
            )}
            {nativeFrameNeedsRestart && (
              <div className="settings-restart-row">
                <button className="btn btn--primary btn--sm" onClick={onRelaunch}>
                  Restart NomadVNC
                </button>
              </div>
            )}
          </>
        ) : (
          <p className="form-hint">Loading window settings…</p>
        )}
      </div>

      <div className="settings-card">
        <div className="settings-card__header">
          <div className="settings-card__icon">
            <ServerIcon style={{ width: 16, height: 16 }} />
          </div>
          <h3 className="settings-section-title">Headless Server Setup</h3>
        </div>
        <HeadlessSetup />
      </div>

      <div className="settings-card">
        <div className="settings-card__header">
          <div className="settings-card__icon">
            <MonitorIcon style={{ width: 16, height: 16 }} />
          </div>
          <h3 className="settings-section-title">Windows PC Setup</h3>
        </div>
        <WindowsPcSetup />
      </div>

      <div className="settings-card settings-card--updates">
        <UpdatesSection />
      </div>

      <div className="settings-card">
        <div className="settings-card__header">
          <h3 className="settings-section-title">Credits</h3>
        </div>
        <p className="form-hint">
          NomadVNC is free and open source. Buy Me a Coffee supports continued development.
        </p>
        <p className="settings-storage-line">
          <a href="https://buymeacoffee.com/greg.tech" target="_blank" rel="noreferrer">
            Buy Me a Coffee
          </a>
        </p>
      </div>
    </div>
  );
}
