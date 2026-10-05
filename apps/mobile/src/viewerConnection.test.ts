import { describe, expect, it } from "vitest";
import {
  CONNECT_WATCHDOG_MS,
  isCredentialProblem,
  MAX_RECONNECT_ATTEMPTS,
  parseViewerEvent,
  RECONNECT_DELAYS_MS,
  reconnectDelayForAttempt,
  RESUME_PROBE_MS,
  resumeActionForState,
} from "./viewerConnection";

describe("parseViewerEvent", () => {
  it("parses a viewerState connected event", () => {
    expect(
      parseViewerEvent(JSON.stringify({ type: "viewerState", state: "connected" })),
    ).toEqual({ type: "viewerState", state: "connected" });
  });

  it("parses a viewerState disconnected event", () => {
    expect(
      parseViewerEvent(JSON.stringify({ type: "viewerState", state: "disconnected" })),
    ).toEqual({ type: "viewerState", state: "disconnected" });
  });

  it("parses a viewerState credentialsRequired event", () => {
    expect(
      parseViewerEvent(
        JSON.stringify({ type: "viewerState", state: "credentialsRequired" }),
      ),
    ).toEqual({ type: "viewerState", state: "credentialsRequired" });
  });

  it("parses viewerReady", () => {
    expect(parseViewerEvent(JSON.stringify({ type: "viewerReady" }))).toEqual({
      type: "viewerReady",
    });
  });

  it("returns null for invalid JSON", () => {
    expect(parseViewerEvent("not json")).toBeNull();
  });

  it("returns null for JSON without a string type", () => {
    expect(parseViewerEvent(JSON.stringify({ state: "connected" }))).toBeNull();
    expect(parseViewerEvent(JSON.stringify({ type: 42 }))).toBeNull();
    expect(parseViewerEvent("null")).toBeNull();
    expect(parseViewerEvent('"viewerState"')).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(parseViewerEvent("")).toBeNull();
  });
});

describe("reconnect backoff", () => {
  it("uses 1s/2s/4s/8s/15s delays", () => {
    expect(RECONNECT_DELAYS_MS).toEqual([1000, 2000, 4000, 8000, 15000]);
  });

  it("returns the delay for each valid attempt", () => {
    expect(reconnectDelayForAttempt(0)).toBe(1000);
    expect(reconnectDelayForAttempt(4)).toBe(15000);
  });

  it("returns null once the budget is exhausted", () => {
    expect(reconnectDelayForAttempt(MAX_RECONNECT_ATTEMPTS)).toBeNull();
    expect(reconnectDelayForAttempt(99)).toBeNull();
  });

  it("returns null for invalid attempts", () => {
    expect(reconnectDelayForAttempt(-1)).toBeNull();
    expect(reconnectDelayForAttempt(1.5)).toBeNull();
    expect(reconnectDelayForAttempt(NaN)).toBeNull();
  });

  it("exposes a positive watchdog timeout", () => {
    expect(CONNECT_WATCHDOG_MS).toBeGreaterThan(0);
  });
});

describe("resumeActionForState", () => {
  it("keeps a live session and checks that the socket survived", () => {
    expect(resumeActionForState("connected")).toBe("probe");
  });

  it("restarts the connect watchdog if the page was still loading", () => {
    expect(resumeActionForState("loading")).toBe("watch");
    expect(resumeActionForState("connecting")).toBe("watch");
  });

  it("reconnects immediately when a retry was frozen in the background", () => {
    expect(resumeActionForState("reconnecting")).toBe("reconnect");
  });

  it("leaves a password prompt or a hard failure alone", () => {
    expect(resumeActionForState("authFailed")).toBe("ignore");
    expect(resumeActionForState("failed")).toBe("ignore");
  });

  it("gives a resumed session a few seconds to answer", () => {
    expect(RESUME_PROBE_MS).toBeGreaterThanOrEqual(1000);
    expect(RESUME_PROBE_MS).toBeLessThan(CONNECT_WATCHDOG_MS);
  });
});

describe("isCredentialProblem", () => {
  it("treats a rejected password like a missing one (prompt, never retry)", () => {
    expect(isCredentialProblem("authFailed")).toBe(true);
    expect(isCredentialProblem("credentialsRequired")).toBe(true);
    expect(isCredentialProblem("disconnected")).toBe(false);
    expect(isCredentialProblem(undefined)).toBe(false);
  });
});
