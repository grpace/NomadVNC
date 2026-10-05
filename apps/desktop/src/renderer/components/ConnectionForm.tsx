import { useState, type FormEvent, type KeyboardEvent } from "react";
import type { Collection, PeerDevice } from "@nomadvnc/domain";
import { RefreshIcon } from "./icons";

interface ConnectionFormProps {
  peers: PeerDevice[];
  selectedPeerId: string;
  machineLabel: string;
  vncPort: string;
  /** macOS Screen Sharing (ARD): account short name, stored with the saved machine. */
  vncUsername: string;
  password: string;
  /** Connect-time host/IP override; takes precedence over the device picker. */
  manualHost: string;
  collections?: Collection[];
  selectedCollectionId?: string;
  savePasswordSecurely: boolean;
  secureStorageAvailable: boolean | null;
  /** Linux keyring / Electron safeStorage guidance when unavailable */
  secureStorageHint?: string;
  isRefreshing: boolean;
  isLoggedIn: boolean;
  isEditing: boolean;
  onPeerChange: (peerId: string) => void;
  onManualHostChange: (host: string) => void;
  onMachineLabelChange: (label: string) => void;
  onVncPortChange: (port: string) => void;
  onVncUsernameChange: (username: string) => void;
  onPasswordChange: (password: string) => void;
  onCollectionChange?: (collectionId: string) => void;
  onCreateCollection?: (name: string) => Collection | null;
  onSavePasswordSecurelyChange: (checked: boolean) => void;
  onRefresh: () => void;
  onSave: () => void;
  onConnect: () => void;
  onCancel?: () => void;
}

export function ConnectionForm({
  peers,
  selectedPeerId,
  machineLabel,
  vncPort,
  vncUsername,
  password,
  manualHost,
  collections = [],
  selectedCollectionId = "",
  savePasswordSecurely,
  secureStorageAvailable,
  secureStorageHint,
  isRefreshing,
  isLoggedIn,
  isEditing,
  onPeerChange,
  onManualHostChange,
  onMachineLabelChange,
  onVncPortChange,
  onVncUsernameChange,
  onPasswordChange,
  onCollectionChange,
  onCreateCollection,
  onSavePasswordSecurelyChange,
  onRefresh,
  onSave,
  onConnect,
  onCancel,
}: ConnectionFormProps) {
  const selectedPeer = peers.find((p) => p.stableId === selectedPeerId);
  const showSecureStorageUnavailableNotice = isEditing && secureStorageAvailable === false;
  const [newGroupName, setNewGroupName] = useState("");
  const [groupError, setGroupError] = useState<string | null>(null);
  const [showUsername, setShowUsername] = useState(false);
  const usernameOpen = showUsername || vncUsername.trim() !== "";

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    if (isEditing) {
      onSave();
      return;
    }
    if (isLoggedIn || manualHost.trim() !== "") {
      onConnect();
    }
  }

  function createGroupOnEnter(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter") {
      event.preventDefault();
      handleCreateGroup();
    }
  }

  function handleCreateGroup(): void {
    if (!onCreateCollection) {
      return;
    }
    const created = onCreateCollection(newGroupName);
    if (!created) {
      setGroupError("Enter a unique group name.");
      return;
    }
    setNewGroupName("");
    setGroupError(null);
    onCollectionChange?.(created.id);
  }

  return (
    <form className="connection-form" onSubmit={handleSubmit}>
      <div className="connection-form__scroll">
      <div className="section-header">
        <h2 className="section-title">{isEditing ? "Edit Machine" : "New Connection"}</h2>
        {/* Refreshing the device list only means something on the tailnet;
            signed out, it would silently start a Tailscale login. */}
        {isLoggedIn && (
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={onRefresh}
            disabled={isRefreshing}
            aria-label={isRefreshing ? "Refreshing devices" : "Refresh devices"}
          >
            <RefreshIcon style={{ width: 14, height: 14, animation: isRefreshing ? "spin 1s linear infinite" : "none" }} />
            Refresh
          </button>
        )}
      </div>

      {/* Tailnet users pick a device first; everyone else (local-first) types
          the address, so that field leads and the empty picker is hidden. */}
      {(isLoggedIn || peers.length > 0) && (
        <div className="form-group">
          <label className="form-label" htmlFor="peer-select">Tailnet Device</label>
          <select
            id="peer-select"
            className="form-select"
            value={selectedPeerId}
            onChange={(e) => onPeerChange(e.target.value)}
          >
            <option value="">{peers.length === 0 ? "No devices found yet" : "Select a device…"}</option>
            {peers.map((peer) => (
              <option key={peer.stableId} value={peer.stableId}>
                {peer.displayName} {peer.online ? "● online" : "○ offline"}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="form-group">
        <label className="form-label" htmlFor="manual-host">
          {isLoggedIn ? "Or Enter an Address" : "Host or IP Address"}
        </label>
        <input
          id="manual-host"
          className="form-input"
          value={manualHost}
          onChange={(e) => onManualHostChange(e.target.value)}
          placeholder={isLoggedIn ? "100.64.0.10 or host.tail.ts.net" : "192.168.1.20 or office-pc.local"}
          autoComplete="off"
          spellCheck={false}
        />
        <p className="form-hint">
          {isLoggedIn
            ? "Optional. Used instead of the device above, for example when a device isn't listed."
            : "The machine's address on your network. Sign in with Tailscale to reach machines anywhere."}
        </p>
      </div>

      <div className="form-group">
        <label className="form-label" htmlFor="machine-label">Label</label>
        <input
          id="machine-label"
          className="form-input"
          value={machineLabel}
          onChange={(e) => onMachineLabelChange(e.target.value)}
          placeholder={selectedPeer?.displayName ?? "e.g. Office PC"}
        />
      </div>

      <div className={showSecureStorageUnavailableNotice ? "form-row form-row--single" : "form-row"}>
        <div className="form-group">
          <label className="form-label" htmlFor="vnc-port">VNC Port</label>
          <input
            id="vnc-port"
            className="form-input"
            value={vncPort}
            onChange={(e) => onVncPortChange(e.target.value)}
            placeholder="5900"
            type="number"
            min="1"
            max="65535"
          />
        </div>
        {!showSecureStorageUnavailableNotice && (
          <div className="form-group">
            <label className="form-label" htmlFor="vnc-password">Password</label>
            <input
              id="vnc-password"
              className="form-input"
              value={password}
              onChange={(e) => onPasswordChange(e.target.value)}
              placeholder={isEditing && savePasswordSecurely ? "Keep current" : "VNC password"}
              type="password"
            />
          </div>
        )}
      </div>

      {usernameOpen ? (
        <div className="form-group">
          <label className="form-label" htmlFor="vnc-username">macOS Username</label>
          <input
            id="vnc-username"
            className="form-input"
            value={vncUsername}
            onChange={(e) => onVncUsernameChange(e.target.value)}
            placeholder="Account short name"
            autoComplete="username"
          />
          <button
            type="button"
            className="form-optional"
            onClick={() => {
              setShowUsername(false);
              onVncUsernameChange("");
            }}
          >
            Hide macOS Username
          </button>
        </div>
      ) : (
        <button type="button" className="form-optional" onClick={() => setShowUsername(true)}>
          Add macOS Username
        </button>
      )}

      <div className="form-group">
        <label className="form-label" htmlFor="machine-group">Group</label>
        <select
          id="machine-group"
          className="form-select"
          value={selectedCollectionId}
          onChange={(e) => onCollectionChange?.(e.target.value)}
        >
          <option value="">No Group</option>
          {collections.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.name}
            </option>
          ))}
        </select>
        {onCreateCollection && (
          <div className="machine-group-bar__new">
            <input
              className="form-input"
              value={newGroupName}
              onChange={(e) => setNewGroupName(e.target.value)}
              onKeyDown={createGroupOnEnter}
              placeholder="New group name"
              aria-label="New group name"
            />
            <button type="button" className="btn btn--secondary btn--sm" onClick={handleCreateGroup}>
              Add
            </button>
          </div>
        )}
        {groupError && <p className="machine-group-bar__error">{groupError}</p>}
      </div>

      {showSecureStorageUnavailableNotice ? (
        <div className="form-checkbox" role="status" aria-live="polite">
          <span className="form-checkbox-label">
            <span className="form-checkbox-title">Secure Storage Is Unavailable on This System</span>
            <span className="form-checkbox-hint">
              {secureStorageHint ?? "Try enabling KDE Wallet/keyring, then restart NomadVNC."}
            </span>
          </span>
        </div>
      ) : (
        <label className="form-checkbox" htmlFor="save-password-securely">
          <input
            id="save-password-securely"
            type="checkbox"
            checked={savePasswordSecurely}
            disabled={!secureStorageAvailable}
            onChange={(e) => onSavePasswordSecurelyChange(e.target.checked)}
          />
          <span className="form-checkbox-label">
            <span className="form-checkbox-title">Save Password Securely</span>
            <span className="form-checkbox-hint">
              {secureStorageAvailable
                ? "Uses OS-level encryption on this device"
                : secureStorageHint ?? "Secure storage unavailable (unlock KDE Wallet/keyring)."}
            </span>
          </span>
        </label>
      )}

      <p className="form-hint">
        {isEditing && savePasswordSecurely && secureStorageAvailable
          ? "Leave the password blank to keep the current saved password."
          : "Machines are stored locally on this device. Sign in to a Nomad account to sync them across devices."}
      </p>
      </div>

      <div className="connection-form__footer">
      <div className={isEditing ? "btn-stack" : "btn-row"}>
        <button
          type={isEditing ? "submit" : "button"}
          className={isEditing ? "btn btn--primary btn--full" : "btn btn--secondary btn--full"}
          onClick={isEditing ? undefined : onSave}
        >
          {isEditing ? "Save Changes" : "Save Machine"}
        </button>
        {!isEditing && (
          <button
            type="submit"
            className="btn btn--primary btn--full"
            // A typed address dials on the OS network (local-first), so it
            // doesn't need the tailnet. Picking a tailnet device does.
            disabled={!isLoggedIn && manualHost.trim() === ""}
            title={
              !isLoggedIn && manualHost.trim() === ""
                ? "Sign in to Tailscale to connect to tailnet devices, or type a manual host/IP to connect on your local network."
                : undefined
            }
          >
            Connect
          </button>
        )}
      </div>

      {onCancel && (
        <button type="button" className="form-optional connection-form__back" onClick={onCancel}>
          {isEditing ? "Cancel Edits" : "← Back to Machines"}
        </button>
      )}
      </div>
    </form>
  );
}
