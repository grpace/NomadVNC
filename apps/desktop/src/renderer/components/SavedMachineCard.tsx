import { useState } from "react";
import type { PeerDevice, SavedMachine } from "@nomadvnc/domain";
import {
  formatLastSeenSuffix,
  formatRelativeTime,
  getMachinePresence,
} from "../presence";
import { EditIcon, LockIcon, MonitorIcon, PlayIcon, ShareIcon, TrashIcon, UnlockIcon } from "./icons";

interface SavedMachineCardProps {
  machine: SavedMachine;
  peers: PeerDevice[];
  isActive: boolean;
  isConnecting: boolean;
  onConnect: (machine: SavedMachine) => void;
  onEdit: (machine: SavedMachine) => void;
  onDelete: (machine: SavedMachine) => void;
  /** Provided only for account machines while signed in (owner-side sharing). */
  onShare?: (machine: SavedMachine) => void;
}

function presenceMeta(machine: SavedMachine, peers: PeerDevice[], connected: boolean): string {
  const presence = getMachinePresence(machine, peers);
  if (connected) {
    return presence.host ? `${presence.host} · Connected` : "Connected";
  }
  if (presence.kind === "online") {
    const lastConnected = formatRelativeTime(machine.lastConnectedAt) ?? "Never Connected";
    return `${presence.host || "Host Unresolved"} · ${lastConnected}`;
  }
  if (presence.kind === "direct") {
    const lastConnected = formatRelativeTime(machine.lastConnectedAt) ?? "Never Connected";
    return `${presence.host} · ${lastConnected}`;
  }
  if (presence.kind === "offline") {
    const suffix = formatLastSeenSuffix(presence.peer?.lastSeen);
    const seen = suffix ? suffix.charAt(0).toUpperCase() + suffix.slice(1) : "Offline";
    return presence.host ? `${presence.host} · ${seen}` : seen;
  }
  return presence.host ? `${presence.host} · Not on Tailnet` : "Not on Tailnet. Check Tailscale";
}

export function SavedMachineCard({ machine, peers, isActive, isConnecting, onConnect, onEdit, onDelete, onShare }: SavedMachineCardProps) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const presence = getMachinePresence(machine, peers);
  const online = presence.kind === "online";

  const cardClass = [
    "machine-card",
    isActive && "machine-card--active",
    isConnecting && "machine-card--connecting",
  ].filter(Boolean).join(" ");

  function handleDelete() {
    if (confirmDelete) {
      onDelete(machine);
      setConfirmDelete(false);
    } else {
      setConfirmDelete(true);

      // Auto-dismiss after 3 seconds
      setTimeout(() => setConfirmDelete(false), 3000);
    }
  }

  return (
    <article className={cardClass} onClick={() => onConnect(machine)} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") { onConnect(machine); } }}>
      <div className="machine-icon">
        <MonitorIcon />
        {/* Address-only machines have no live presence signal: no dot. */}
        {presence.kind !== "direct" && (
          <span className={`machine-icon-dot ${online ? "machine-icon-dot--online" : "machine-icon-dot--offline"}`} />
        )}
      </div>

      <div className="machine-info">
        <h3 className="machine-name">{machine.label}</h3>
        <p className="machine-meta">
          {presenceMeta(machine, peers, isActive)}
        </p>
        <span
          className={machine.credentialMode === "prompt" ? "machine-badge machine-badge--prompt" : "machine-badge machine-badge--secure"}
          title={machine.credentialMode === "prompt" ? "The password is asked each time you connect." : undefined}
        >
          {machine.credentialMode === "localSecure"
            ? <><LockIcon style={{ width: 10, height: 10 }} /> Secured</>
            : machine.credentialMode === "cloudSecure"
              ? <><LockIcon style={{ width: 10, height: 10 }} /> Synced</>
              : <><UnlockIcon style={{ width: 10, height: 10 }} /> Asks Each Time</>
          }
        </span>
      </div>

      <div className="machine-actions" onClick={(e) => e.stopPropagation()}>
        {confirmDelete ? (
          <div className="delete-confirm">
            <button className="btn btn--danger btn--sm" onClick={handleDelete} title="Confirm Delete">
              Delete?
            </button>
            <button className="btn btn--secondary btn--sm" onClick={() => setConfirmDelete(false)} title="Cancel Delete">
              No
            </button>
          </div>
        ) : (
          <>
            <button className="btn btn--secondary btn--icon" onClick={() => onEdit(machine)} title="Edit Machine">
              <EditIcon />
            </button>
            {onShare && (
              <button className="btn btn--secondary btn--icon" onClick={() => onShare(machine)} title="Share Machine">
                <ShareIcon style={{ width: 12, height: 12 }} />
              </button>
            )}
            <button className="btn btn--secondary btn--icon" onClick={handleDelete} title="Delete Machine">
              <TrashIcon />
            </button>
            <button className="btn btn--primary btn--sm" onClick={() => onConnect(machine)} title="Connect" disabled={isActive || isConnecting}>
              <PlayIcon style={{ width: 12, height: 12 }} /> {isActive ? "Connected" : isConnecting ? "Connecting" : "Connect"}
            </button>
          </>
        )}
      </div>
    </article>
  );
}
