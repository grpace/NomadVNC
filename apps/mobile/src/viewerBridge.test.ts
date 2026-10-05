import { describe, expect, it } from "vitest";
import { parseViewerEvent } from "./viewerConnection";

/**
 * Verifies the POST_MESSAGE_SHIM contract in ViewerScreen.tsx.
 *
 * The shim replaces `window.postMessage` so the shared viewer bootstrap's
 * `window.parent.postMessage(event, "*")` calls are forwarded to
 * `window.ReactNativeWebView.postMessage(JSON.stringify(event))`.
 * React Native delivers that string to `onMessage` as
 * `event.nativeEvent.data`, which `parseViewerEvent` must decode.
 *
 * These tests simulate the full path: bootstrap event object →
 * shim serialization → parseViewerEvent → viewer state.
 */
describe("viewer event bridge (POST_MESSAGE_SHIM contract)", () => {
  // Simulates what the shim does: JSON.stringify non-strings.
  function shimSerialize(msg: unknown): string {
    return typeof msg === "string" ? msg : JSON.stringify(msg);
  }

  it("bridges viewerState connected", () => {
    const data = shimSerialize({ type: "viewerState", state: "connected" });
    const parsed = parseViewerEvent(data);
    expect(parsed?.type).toBe("viewerState");
    expect(parsed?.state).toBe("connected");
  });

  it("bridges viewerState disconnected", () => {
    const data = shimSerialize({ type: "viewerState", state: "disconnected" });
    const parsed = parseViewerEvent(data);
    expect(parsed?.type).toBe("viewerState");
    expect(parsed?.state).toBe("disconnected");
  });

  it("bridges viewerState credentialsRequired", () => {
    const data = shimSerialize({ type: "viewerState", state: "credentialsRequired" });
    const parsed = parseViewerEvent(data);
    expect(parsed?.type).toBe("viewerState");
    expect(parsed?.state).toBe("credentialsRequired");
  });

  it("bridges viewerReady (ignored by the state machine, but must parse)", () => {
    const data = shimSerialize({ type: "viewerReady" });
    const parsed = parseViewerEvent(data);
    expect(parsed?.type).toBe("viewerReady");
  });

  it("passes through pre-stringified payloads without double-encoding", () => {
    const raw = '{"type":"viewerState","state":"connected"}';
    const data = shimSerialize(raw);
    expect(data).toBe(raw);
    expect(parseViewerEvent(data)?.state).toBe("connected");
  });

  it("rejects non-viewer payloads", () => {
    expect(parseViewerEvent("not json")).toBeNull();
    expect(parseViewerEvent('{"nope":1}')).toBeNull();
    expect(parseViewerEvent("42")).toBeNull();
  });
});
