import { describe, expect, it } from "vitest";
import { buildConnectInput } from "./connectInput";
import type { PeerDevice } from "@nomadvnc/domain";

const peer: PeerDevice = {
  stableId: "p1",
  displayName: "workstation",
  dnsName: "workstation.tail12345.ts.net",
  tailnetIps: ["100.64.0.2"],
  online: true,
};

describe("buildConnectInput", () => {
  it("prefers a typed host and marks it direct (local-first)", () => {
    const result = buildConnectInput({ peer, host: " 192.168.1.50 ", port: 5900 }, "tok");
    expect(result).toEqual({
      ok: true,
      input: { host: "192.168.1.50", port: 5900, sessionToken: "tok", direct: true },
    });
  });

  it("uses the selected peer without the direct flag", () => {
    const result = buildConnectInput({ peer, port: 5901 }, "tok");
    expect(result).toEqual({
      ok: true,
      input: { host: "workstation.tail12345.ts.net", port: 5901, sessionToken: "tok" },
    });
  });

  it("falls back to the peer tailnet IP when no DNS name exists", () => {
    const noDns = { ...peer, dnsName: undefined };
    const result = buildConnectInput({ peer: noDns, port: 5900 }, "tok");
    expect(result.ok && result.input.host).toBe("100.64.0.2");
  });

  it("rejects an empty selection with guidance", () => {
    const result = buildConnectInput({ port: 5900 }, "tok");
    expect(result).toEqual({ ok: false, error: "Choose a device or type a host/IP first" });
  });

  it("rejects invalid ports", () => {
    expect(buildConnectInput({ host: "h", port: 0 }, "tok")).toEqual({
      ok: false,
      error: "Enter a valid VNC port (1–65535)",
    });
    expect(buildConnectInput({ peer, port: 70000 }, "tok")).toEqual({
      ok: false,
      error: "Enter a valid VNC port (1–65535)",
    });
  });
});
