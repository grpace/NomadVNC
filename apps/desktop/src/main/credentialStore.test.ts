// @vitest-environment node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DesktopCredentialStore, type SecureStorageAdapter } from "./credentialStore";

class FakeSecureStorage implements SecureStorageAdapter {
  constructor(private readonly available = true) {}

  isEncryptionAvailable(): boolean {
    return this.available;
  }

  encryptString(value: string): Buffer {
    return Buffer.from(`enc:${value}`, "utf8");
  }

  decryptString(value: Buffer): string {
    return value.toString("utf8").replace(/^enc:/, "");
  }
}

const tempDirs: string[] = [];

function createStore(available = true) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomadvnc-credentials-"));
  tempDirs.push(tempDir);
  return new DesktopCredentialStore({
    filePath: path.join(tempDir, "credential-store.json"),
    secureStorage: new FakeSecureStorage(available),
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const next = tempDirs.pop();
    if (next && fs.existsSync(next)) {
      fs.rmSync(next, { recursive: true, force: true });
    }
  }
});

describe("DesktopCredentialStore", () => {
  it("stores and retrieves encrypted credentials", async () => {
    const store = createStore();

    await store.setPassword("machine-1", "hunter2");

    await expect(store.getPassword("machine-1")).resolves.toBe("hunter2");
  });

  it("migrates legacy un-namespaced passwords forward", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nomadvnc-credentials-"));
    tempDirs.push(tempDir);
    const filePath = path.join(tempDir, "credential-store.json");
    const fake = new FakeSecureStorage(true);
    fs.writeFileSync(
      filePath,
      JSON.stringify({ version: 1, items: { "machine-9": fake.encryptString("legacy").toString("base64") } }),
    );
    const store = new DesktopCredentialStore({ filePath, secureStorage: fake });

    await expect(store.getPassword("machine-9")).resolves.toBe("legacy");
    // Second read comes from the namespaced slot; legacy entry is gone.
    await expect(store.getPassword("machine-9")).resolves.toBe("legacy");
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as { items: Record<string, string> };
    expect("machine-9" in raw.items).toBe(false);
    expect("machine:machine-9" in raw.items).toBe(true);
  });

  it("stores generic secrets such as the account token", async () => {
    const store = createStore();

    await expect(store.getSecret("nomad:account-token")).resolves.toBeNull();
    await store.setSecret("nomad:account-token", "jwt-value");
    await expect(store.getSecret("nomad:account-token")).resolves.toBe("jwt-value");
    await store.deleteSecret("nomad:account-token");
    await expect(store.getSecret("nomad:account-token")).resolves.toBeNull();
  });

  it("deletes stored credentials cleanly", async () => {
    const store = createStore();

    await store.setPassword("machine-1", "hunter2");
    await store.deletePassword("machine-1");

    await expect(store.getPassword("machine-1")).resolves.toBeNull();
  });

  it("writes atomically with owner-only permissions and no temp leftovers", async () => {
    const store = createStore();
    await store.setPassword("machine-1", "first");
    await store.setPassword("machine-1", "second");
    const dir = tempDirs[tempDirs.length - 1] as string;
    expect(fs.readdirSync(dir)).toEqual(["credential-store.json"]);
    if (process.platform !== "win32") {
      expect(fs.statSync(path.join(dir, "credential-store.json")).mode & 0o777).toBe(0o600);
    }
    await expect(store.getPassword("machine-1")).resolves.toBe("second");
  });

  it("reports secure-storage availability", () => {
    expect(createStore(true).canUseSecureStorage()).toBe(true);
    expect(createStore(false).canUseSecureStorage()).toBe(false);
  });

  it("rejects writes when secure storage is unavailable", async () => {
    const store = createStore(false);

    await expect(store.setPassword("machine-1", "hunter2")).rejects.toThrow("Secure credential storage is unavailable");
  });
});
