// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SidecarManager } from "./sidecarManager";

function createManager(binaryPath: string): SidecarManager {
  return new SidecarManager({
    binaryPath,
    stateDir: "/tmp/nomadvnc-sidecar-status-test",
  });
}

describe("SidecarManager.getSidecarStatus", () => {
  it("reports not-running without a message before the first start attempt", () => {
    const manager = createManager("/nonexistent/nomadvnc-sidecar-test-binary");
    expect(manager.getSidecarStatus()).toEqual({ running: false });
  });

  it("reports the failure reason after a failed start", async () => {
    const manager = createManager("/nonexistent/nomadvnc-sidecar-test-binary");
    await expect(manager.ensureStarted()).rejects.toThrow("binary not found");
    const status = manager.getSidecarStatus();
    expect(status.running).toBe(false);
    expect(status.message).toContain("binary not found");
  });

  it("keeps reporting the failure across repeated failed starts", async () => {
    const manager = createManager("/nonexistent/nomadvnc-sidecar-test-binary");
    await expect(manager.ensureStarted()).rejects.toThrow();
    await expect(manager.ensureStarted()).rejects.toThrow();
    expect(manager.getSidecarStatus().running).toBe(false);
    expect(manager.getSidecarStatus().message).toContain("binary not found");
  });

  it("makes a fresh start attempt when the binary appears after a failure", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomadvnc-sidecar-retry-"));
    const binaryPath = path.join(dir, "nomadvnc-sidecar");
    const manager = createManager(binaryPath);
    try {
      await expect(manager.ensureStarted()).rejects.toThrow("binary not found");

      // The binary shows up later (e.g. the user installs the package):
      // the retry must spawn for real, not re-reject a stale cached promise.
      fs.writeFileSync(binaryPath, "#!/bin/sh\nsleep 30\n");
      fs.chmodSync(binaryPath, 0o755);
      await expect(manager.ensureStarted()).resolves.toBeUndefined();
      expect(manager.getSidecarStatus()).toEqual({ running: true });
    } finally {
      await manager.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SidecarManager requests and shutdown", () => {
  function fakeSidecar(script: string): { dir: string; binaryPath: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nomadvnc-sidecar-fake-"));
    const binaryPath = path.join(dir, "nomadvnc-sidecar");
    fs.writeFileSync(binaryPath, `#!/bin/sh\n${script}\n`);
    fs.chmodSync(binaryPath, 0o755);
    return { dir, binaryPath };
  }

  it("rejects a request the sidecar never answers instead of hanging forever", async () => {
    const { dir, binaryPath } = fakeSidecar("sleep 30");
    const manager = new SidecarManager({
      binaryPath,
      stateDir: path.join(dir, "state"),
      requestTimeoutMs: () => 50,
    });
    try {
      await expect(manager.getTailnetState()).rejects.toThrow("did not answer getTailnetState");
    } finally {
      await manager.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects pending requests when the sidecar dies, without crashing on the dead pipe", async () => {
    const { dir, binaryPath } = fakeSidecar("exit 0");
    const manager = new SidecarManager({ binaryPath, stateDir: path.join(dir, "state") });
    try {
      await expect(manager.getTailnetState()).rejects.toThrow();
      // The process is gone now; dispose must resolve rather than wait for
      // an exit event that already fired.
      await expect(manager.dispose()).resolves.toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
