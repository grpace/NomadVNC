import { useEffect, useMemo, useState } from "react";
import type { Collection, PeerDevice, SavedMachine } from "@nomadvnc/domain";
import {
  DEFAULT_MACHINE_LIST_QUERY,
  filterMachines,
  type MachineCredentialFilter,
  type MachineSortKey,
  type MachineStatusFilter,
} from "../machineList";
import type { BackendSharedDeviceView } from "../accountClient";
import { SavedMachineCard } from "./SavedMachineCard";
import { ServerIcon, ShareIcon } from "./icons";

interface QuickConnectProps {
  machines: SavedMachine[];
  peers: PeerDevice[];
  activeMachineId?: string;
  connectingMachineId?: string;
  collections?: Collection[];
  /** Devices shared with me (owner-side metadata only — connect lands later). */
  sharedDevices?: BackendSharedDeviceView[];
  onConnect: (machine: SavedMachine) => void;
  onEdit: (machine: SavedMachine) => void;
  onDelete: (machine: SavedMachine) => void;
  /** Provided for account machines while signed in; gates the card Share button. */
  onShare?: (machine: SavedMachine) => void;
  isAccountMachine?: (machine: SavedMachine) => boolean;
  onSwitchToForm: () => void;
  onDeleteCollection?: (collection: Collection) => void;
}

/** Below this many saved machines, the list shows without search/filter controls. */
const FILTER_CONTROLS_MIN_MACHINES = 3;

export function QuickConnect({ machines, peers, activeMachineId, connectingMachineId, collections = [], sharedDevices = [], onConnect, onEdit, onDelete, onShare, isAccountMachine, onSwitchToForm, onDeleteCollection }: QuickConnectProps) {
  const [search, setSearch] = useState(DEFAULT_MACHINE_LIST_QUERY.search);
  const [status, setStatus] = useState<MachineStatusFilter>(DEFAULT_MACHINE_LIST_QUERY.status);
  const [credential, setCredential] = useState<MachineCredentialFilter>(DEFAULT_MACHINE_LIST_QUERY.credential);
  const [sort, setSort] = useState<MachineSortKey>(DEFAULT_MACHINE_LIST_QUERY.sort);
  const [collection, setCollection] = useState(DEFAULT_MACHINE_LIST_QUERY.collection);
  const [confirmDeleteCollection, setConfirmDeleteCollection] = useState(false);

  // A deleted group must not leave the filter pointing at nothing.
  useEffect(() => {
    if (collection !== "all" && collection !== "ungrouped"
      && !collections.some((entry) => entry.id === collection)) {
      setCollection("all");
      setConfirmDeleteCollection(false);
    }
  }, [collections, collection]);

  const visibleMachines = useMemo(
    () => filterMachines(machines, peers, { search, status, credential, sort, collection }),
    [machines, peers, search, status, credential, sort, collection],
  );
  const selectedCollection = collections.find((entry) => entry.id === collection);
  const hasActiveFilters = search.trim() !== "" || status !== "all" || credential !== "all" || sort !== "name";
  // Search/filter/sort are noise for a handful of machines. An active
  // filter keeps the bar visible so it can never hide itself.
  const showFilterControls = machines.length >= FILTER_CONTROLS_MIN_MACHINES || hasActiveFilters;

  function clearFilters(): void {
    setSearch(DEFAULT_MACHINE_LIST_QUERY.search);
    setStatus(DEFAULT_MACHINE_LIST_QUERY.status);
    setCredential(DEFAULT_MACHINE_LIST_QUERY.credential);
    setCollection(DEFAULT_MACHINE_LIST_QUERY.collection);
  }

  function countFor(collectionId: string | undefined): number {
    return machines.filter((machine) => machine.collectionId === collectionId).length;
  }

  if (machines.length === 0 && sharedDevices.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">
          <ServerIcon />
        </div>
        <h3>No Saved Machines Yet</h3>
        <p>
          Save a machine by its address, or pick one from your tailnet, for one-click connections.
        </p>
        <button className="btn btn--primary" onClick={onSwitchToForm}>
          Add Your First Machine
        </button>
      </div>
    );
  }

  return (
    <>
      <div className="section-header">
        <h2 className="section-title">Saved Machines</h2>
        <span className="section-count">
          {visibleMachines.length === machines.length
            ? `${machines.length}`
            : `${visibleMachines.length} of ${machines.length}`}
        </span>
      </div>

      <div className="machine-filter-bar">
        {showFilterControls && (
          <input
            type="search"
            className="form-input machine-filter-bar__search"
            placeholder="Search machines…"
            aria-label="Search saved machines"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        )}
        {collections.length > 0 && (
          <select
            className="form-select"
            aria-label="Filter by group"
            value={collection}
            onChange={(event) => {
              setCollection(event.target.value);
              setConfirmDeleteCollection(false);
            }}
          >
            <option value="all">All Groups ({machines.length})</option>
            <option value="ungrouped">Ungrouped ({countFor(undefined)})</option>
            {collections.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name} ({countFor(entry.id)})
              </option>
            ))}
          </select>
        )}
        {showFilterControls && (
        <div className="machine-filter-bar__row">
          <select
            className="form-select"
            aria-label="Filter by status"
            value={status}
            onChange={(event) => setStatus(event.target.value as MachineStatusFilter)}
          >
            <option value="all">All Statuses</option>
            <option value="online">Online</option>
            <option value="offline">Offline</option>
          </select>
          <select
            className="form-select"
            aria-label="Filter by credential"
            value={credential}
            onChange={(event) => setCredential(event.target.value as MachineCredentialFilter)}
          >
            <option value="all">All Passwords</option>
            <option value="localSecure">Saved Password</option>
            <option value="prompt">Asks Each Time</option>
          </select>
          <select
            className="form-select machine-filter-bar__sort"
            aria-label="Sort machines"
            value={sort}
            onChange={(event) => setSort(event.target.value as MachineSortKey)}
          >
            <option value="name">Sort: Name A–Z</option>
            <option value="recent">Sort: Recently Connected</option>
            <option value="online-first">Sort: Online First</option>
          </select>
        </div>
        )}
      </div>

      {selectedCollection && onDeleteCollection && (
        <div className="machine-group-bar">
          <span className="machine-group-bar__name">{selectedCollection.name}</span>
          {confirmDeleteCollection ? (
            <span className="machine-group-bar__confirm">
              <button
                className="btn btn--danger btn--sm"
                onClick={() => onDeleteCollection(selectedCollection)}
                title="Confirm Delete Group"
              >
                Delete?
              </button>
              <button
                className="btn btn--secondary btn--sm"
                onClick={() => setConfirmDeleteCollection(false)}
                title="Cancel Delete Group"
              >
                No
              </button>
            </span>
          ) : (
            <button
              className="btn btn--secondary btn--sm"
              onClick={() => setConfirmDeleteCollection(true)}
              title="Delete Group (Machines Stay Saved)"
            >
              Delete Group
            </button>
          )}
        </div>
      )}

      {visibleMachines.length === 0 ? (
        <div className="empty-state">
          <h3>No Machines Match</h3>
          <p>Try a different search or clear the filters to see the full library.</p>
          <button className="btn btn--secondary" onClick={clearFilters}>
            Clear Search &amp; Filters
          </button>
        </div>
      ) : (
        <div className="machine-list">
          {visibleMachines.map((machine) => (
            <SavedMachineCard
              key={machine.id}
              machine={machine}
              peers={peers}
              isActive={machine.id === activeMachineId}
              isConnecting={machine.id === connectingMachineId}
              onConnect={onConnect}
              onEdit={onEdit}
              onDelete={onDelete}
              onShare={onShare && isAccountMachine?.(machine) ? onShare : undefined}
            />
          ))}
        </div>
      )}

      {sharedDevices.length > 0 && (
        <>
          <div className="section-header">
            <h2 className="section-title">Shared With Me</h2>
            <span className="section-count">{`${sharedDevices.length}`}</span>
          </div>
          <p className="form-hint">
            Devices other Nomad accounts shared with you. Connecting to a shared device
            arrives in a later update.
          </p>
          <div className="machine-list">
            {sharedDevices.map((device) => (
              <article key={device.id} className="machine-card machine-card--shared">
                <div className="machine-icon">
                  <ShareIcon style={{ width: 16, height: 16 }} />
                </div>
                <div className="machine-info">
                  <h3 className="machine-name">{device.label}</h3>
                  <p className="machine-meta">
                    Shared by {device.sharedBy}
                    {device.dnsName ? ` · ${device.dnsName}` : ""} · :{device.vncPort}
                  </p>
                  <span className="machine-badge machine-badge--prompt">
                    {device.hasTailnetKey ? "Key attached" : "Same-tailnet"}
                  </span>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </>
  );
}
