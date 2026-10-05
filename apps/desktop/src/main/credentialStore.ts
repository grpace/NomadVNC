import fs from "node:fs";
import path from "node:path";

interface CredentialFile {
  version: 1;
  items: Record<string, string>;
}

export interface SecureStorageAdapter {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

interface DesktopCredentialStoreOptions {
  filePath: string;
  secureStorage: SecureStorageAdapter;
}

const EMPTY_FILE: CredentialFile = {
  version: 1,
  items: {},
};

export class DesktopCredentialStore {
  private readonly filePath: string;
  private readonly secureStorage: SecureStorageAdapter;

  constructor(options: DesktopCredentialStoreOptions) {
    this.filePath = options.filePath;
    this.secureStorage = options.secureStorage;
  }

  canUseSecureStorage(): boolean {
    return this.secureStorage.isEncryptionAvailable();
  }

  async getPassword(machineId: string): Promise<string | null> {
    const namespaced = await this.getSecret(`machine:${machineId}`);
    if (namespaced !== null) {
      return namespaced;
    }
    // Legacy slot from before key namespacing: read it and migrate forward
    // so pre-existing saved passwords keep working.
    const legacy = await this.getSecret(machineId);
    if (legacy === null) {
      return null;
    }
    try {
      await this.setSecret(`machine:${machineId}`, legacy);
      await this.deleteSecret(machineId);
    } catch {
      // Migration is best-effort; the read above already succeeded.
    }
    return legacy;
  }

  async setPassword(machineId: string, password: string): Promise<void> {
    await this.setSecret(`machine:${machineId}`, password);
  }

  async deletePassword(machineId: string): Promise<void> {
    await this.deleteSecret(`machine:${machineId}`);
  }

  /** Generic OS-encrypted secret slot (account token, future OAuth, …). */
  async getSecret(key: string): Promise<string | null> {
    const data = this.readFile();
    const encoded = data.items[key];
    if (!encoded) {
      return null;
    }

    if (!this.canUseSecureStorage()) {
      throw new Error("Secure credential storage is unavailable on this system");
    }

    return this.secureStorage.decryptString(Buffer.from(encoded, "base64"));
  }

  async setSecret(key: string, value: string): Promise<void> {
    if (!this.canUseSecureStorage()) {
      throw new Error("Secure credential storage is unavailable on this system");
    }

    const data = this.readFile();
    data.items[key] = this.secureStorage.encryptString(value).toString("base64");
    this.writeFile(data);
  }

  async deleteSecret(key: string): Promise<void> {
    const data = this.readFile();
    if (!(key in data.items)) {
      return;
    }

    delete data.items[key];
    this.writeFile(data);
  }

  private readFile(): CredentialFile {
    if (!fs.existsSync(this.filePath)) {
      return { ...EMPTY_FILE, items: {} };
    }

    const raw = fs.readFileSync(this.filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<CredentialFile>;

    if (parsed.version !== 1 || !parsed.items || typeof parsed.items !== "object") {
      throw new Error("Credential store file is invalid");
    }

    return {
      version: 1,
      items: { ...parsed.items },
    };
  }

  private writeFile(data: CredentialFile): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    // Owner-only permissions: the blobs are safeStorage-encrypted, but the
    // file shouldn't be world-readable on shared machines either. Mode bits
    // are honored on Linux/macOS and ignored on Windows (ACLs apply there).
    // Write-then-rename so a crash or full disk mid-write leaves the old
    // file intact instead of truncated JSON that locks out every secret.
    const tempPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), { encoding: "utf8", mode: 0o600 });
      fs.renameSync(tempPath, this.filePath);
    } catch (error) {
      fs.rmSync(tempPath, { force: true });
      throw error;
    }
  }
}
