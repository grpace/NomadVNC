import type { SessionLayout } from "../appSettings";
import type { SessionLiveState } from "./SessionView";
import { GridIcon, MinimizeIcon, TabsIcon, WindowCloseIcon } from "./icons";

export interface SessionStripEntry {
  id: string;
  label: string;
  state: SessionLiveState;
}

interface SessionStripProps {
  sessions: SessionStripEntry[];
  focusedId: string | null;
  layout: SessionLayout;
  isFullscreen: boolean;
  onFocus: (id: string) => void;
  onClose: (id: string) => void;
  onLayoutChange: (layout: SessionLayout) => void;
  onExitFullscreen: () => void;
}

const STATE_TITLES: Record<SessionLiveState, string> = {
  live: "Live",
  connecting: "Connecting",
  down: "Connection lost",
};

/** Open sessions as tabs, plus the tabs/grid switch. Shown with two or more sessions. */
export function SessionStrip({
  sessions,
  focusedId,
  layout,
  isFullscreen,
  onFocus,
  onClose,
  onLayoutChange,
  onExitFullscreen,
}: SessionStripProps) {
  return (
    <div className={`session-strip ${isFullscreen ? "session-strip--fullscreen" : ""}`}>
      <div className="session-strip__tabs" role="tablist" aria-label="Open sessions">
        {sessions.map((entry) => {
          const focused = entry.id === focusedId;
          return (
            <div key={entry.id} className={`session-tab ${focused ? "session-tab--active" : ""}`}>
              <button
                type="button"
                role="tab"
                aria-selected={focused}
                className="session-tab__label"
                onClick={() => onFocus(entry.id)}
                title={`${entry.label} · ${STATE_TITLES[entry.state]}`}
              >
                <span className={`session-tab__dot session-tab__dot--${entry.state}`} />
                <span className="session-tab__name">{entry.label}</span>
              </button>
              <button
                type="button"
                className="session-tab__close"
                onClick={() => onClose(entry.id)}
                aria-label={`Disconnect ${entry.label}`}
                title={`Disconnect ${entry.label}`}
              >
                <WindowCloseIcon />
              </button>
            </div>
          );
        })}
      </div>
      <div className="session-strip__actions">
        <div className="toolbar-group" role="group" aria-label="Session layout">
          <button
            type="button"
            className={`btn btn--toolbar ${layout === "tabs" ? "btn--toolbar-active" : ""}`}
            aria-pressed={layout === "tabs"}
            onClick={() => onLayoutChange("tabs")}
            title="One at a Time"
          >
            <TabsIcon style={{ width: 15, height: 15 }} />
          </button>
          <button
            type="button"
            className={`btn btn--toolbar ${layout === "grid" ? "btn--toolbar-active" : ""}`}
            aria-pressed={layout === "grid"}
            onClick={() => onLayoutChange("grid")}
            title="Show All Side by Side"
          >
            <GridIcon style={{ width: 15, height: 15 }} />
          </button>
        </div>
        {isFullscreen && (
          <button type="button" className="btn btn--toolbar" onClick={onExitFullscreen} title="Exit Fullscreen">
            <MinimizeIcon style={{ width: 15, height: 15 }} />
          </button>
        )}
      </div>
    </div>
  );
}
