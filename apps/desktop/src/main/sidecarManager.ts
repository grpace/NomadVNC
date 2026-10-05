import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type {
  NomadNativeEvent,
  PeerPathInfo,
  SidecarStatus,
  StartVncSessionInput,
  StartVncSessionResult,
  TailscaleHostnameResult,
} from "@nomadvnc/platform-contracts";
import type { PeerDevice, TailnetState } from "@nomadvnc/domain";

/** Go sidecar JSON uses `statePayload` for tailnet snapshots; renderer contracts use `state`. */
function normalizeSidecarEvent(raw: unknown): NomadNativeEvent {
  if (!raw || typeof raw !== "object") {
    return { type: "error", scope: "tailnet", message: "Invalid sidecar event" };
  }

  const obj = raw as Record<string, unknown>;
  if (obj.type === "tailnetState") {
    const state = (obj.state ?? obj.statePayload) as TailnetState | undefined;
    if (state && typeof state === "object") {
      return { type: "tailnetState", state };
    }

    return {
      type: "error",
      scope: "tailnet",
      message: "Sidecar sent tailnetState without a state payload",
    };
  }

  return raw as NomadNativeEvent;
}

interface SidecarRequest {
  id: string;
  method: string;
  params?: unknown;
}

interface SidecarResponse<T = unknown> {
  id: string;
  ok: boolean;
  result?: T;
  error?: string;
  event?: NomadNativeEvent;
}

interface SidecarManagerOptions {
  binaryPath: string;
  stateDir: string;
  /** Chosen tailnet name, applied the next time this process starts the sidecar. */
  tailscaleHostname?: string;
  /** Override per-request timeouts (tests). */
  requestTimeoutMs?: (method: string) => number;
}

/**
 * Upper bound per sidecar call so a wedged request can't leave the UI
 * waiting forever. Auth-key logins legitimately wait up to 60s in the
 * engine; everything else answers in seconds.
 */
export function defaultRequestTimeoutMs(method: string): number {
  return method === "ensureTailnetReady" ? 90_000 : 30_000;
}

/** How long dispose waits for a graceful exit before SIGKILL. */
const DISPOSE_GRACE_MS = 3_000;

export class SidecarManager extends EventEmitter {
  private readonly binaryPath: string;
  private readonly stateDir: string;
  private tailscaleHostname: string;
  private readonly requestTimeoutMs: (method: string) => number;
  private process?: ChildProcessWithoutNullStreams;
  private startup?: Promise<void>;
  private lastStartError: string | null = null;
  private buffer = "";
  private pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(options: SidecarManagerOptions) {
    super();
    this.binaryPath = options.binaryPath;
    this.stateDir = options.stateDir;
    this.tailscaleHostname = options.tailscaleHostname?.trim() ?? "";
    this.requestTimeoutMs = options.requestTimeoutMs ?? defaultRequestTimeoutMs;
  }

  async ensureStarted(): Promise<void> {
    if (this.process) {
      return;
    }

    if (this.startup) {
      return this.startup;
    }

    // Check before caching the promise: a missing binary must throw fresh
    // every time so a later retry (after the binary appears) makes a real
    // new start attempt instead of re-rejecting a stale cached promise.
    if (!fs.existsSync(this.binaryPath)) {
      this.lastStartError = `NomadVNC sidecar binary not found at ${this.binaryPath}`;
      throw new Error(this.lastStartError);
    }

    this.startup = new Promise<void>((resolve, reject) => {
      fs.mkdirSync(this.stateDir, { recursive: true });

      const child = spawn(this.binaryPath, [], {
        cwd: path.dirname(this.binaryPath),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: {
          // process.env is spread, so an ambient NOMADVNC_AUTHKEY reaches
          // the sidecar for headless setups; absent by default, keeping
          // interactive login the normal path.
          ...process.env,
          NOMADVNC_STATE_DIR: this.stateDir,
          ...(this.tailscaleHostname ? { NOMADVNC_TSNET_HOSTNAME: this.tailscaleHostname } : {}),
        },
      });

      this.process = child;
      // Writing to a dead child's stdin emits EPIPE on the stream; without
      // a listener that is an uncaught exception that takes down the app.
      // The exit handler already rejects pending requests.
      child.stdin.on("error", (error) => {
        console.warn(`[sidecar] stdin error: ${error.message}`);
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        // Stderr from Go/Tailscale contains many informational logs (including login URLs).
        // We log these to the console for debugging but don't surface them as UI error toasts
        // unless they are delivered as structured events over stdout.
        console.log(`[sidecar:stderr] ${chunk.trim()}`);
      });
      child.once("spawn", () => {
        this.startup = undefined;
        this.lastStartError = null;
        resolve();
      });
      child.once("error", (error) => {
        this.process = undefined;
        this.startup = undefined;
        this.lastStartError = error.message;
        reject(error);
      });
      child.on("exit", (_code, signal) => {
        const unexpected = this.process === child;
        this.process = undefined;
        this.startup = undefined;
        const message = signal
          ? `NomadVNC sidecar exited from signal ${signal}`
          : "NomadVNC sidecar exited unexpectedly";
        if (unexpected) {
          this.lastStartError = message;
        }
        this.rejectPending(new Error(message));
      });
    });

    return this.startup;
  }

  async dispose(): Promise<void> {
    this.startup = undefined;
    const child = this.process;
    this.process = undefined;

    if (!child) {
      return;
    }

    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => child.kill("SIGKILL"), DISPOSE_GRACE_MS);
      child.once("exit", () => {
        clearTimeout(force);
        resolve();
      });
      child.kill();
    });
  }

  subscribe(listener: (event: NomadNativeEvent) => void): () => void {
    this.on("event", listener);
    return () => this.off("event", listener);
  }

  /**
   * Current health of the sidecar process. `running` is false while the
   * first startup is still in flight or after a failed start / unexpected
   * exit; `message` is present only for a real failure (absent while
   * startup is still pending).
   */
  getSidecarStatus(): SidecarStatus {
    if (this.process) {
      return { running: true };
    }
    return this.lastStartError ? { running: false, message: this.lastStartError } : { running: false };
  }

  async ensureTailnetReady(): Promise<TailnetState> {
    return this.request<TailnetState>("ensureTailnetReady");
  }

  async getTailnetPeers(): Promise<PeerDevice[]> {
    return this.request<PeerDevice[]>("getTailnetPeers");
  }

  async startVncSession(input: StartVncSessionInput): Promise<StartVncSessionResult> {
    return this.request<StartVncSessionResult>("startVncSession", input);
  }

  async stopVncSession(sessionId: string): Promise<void> {
    await this.request("stopVncSession", { sessionId });
  }

  async getTailnetState(): Promise<TailnetState> {
    return this.request<TailnetState>("getTailnetState");
  }

  async logoutTailnet(): Promise<TailnetState> {
    return this.request<TailnetState>("logoutTailnet");
  }

  /** Forces a fresh interactive sign-in (expiring-soon path). */
  async reauthenticateTailnet(): Promise<TailnetState> {
    return this.request<TailnetState>("reauthenticateTailnet");
  }

  /**
   * Wipes the persistent tsnet identity so the next bring-up registers a
   * brand-new device. Escape hatch for revoked/deleted node keys where
   * logout/login alone can't recover.
   */
  /**
   * Stores the tailnet name and, when the node is already up, renames it.
   * Does not start Tailscale. The name is also kept for the next sidecar
   * start in this process.
   */
  async setTailscaleHostname(hostname: string): Promise<TailscaleHostnameResult> {
    this.tailscaleHostname = hostname.trim();
    return this.request<TailscaleHostnameResult>("setTailscaleHostname", {
      hostname: this.tailscaleHostname,
    });
  }

  async resetTailnetIdentity(): Promise<TailnetState> {
    return this.request<TailnetState>("resetTailnetIdentity");
  }

  async getPeerPath(host: string): Promise<PeerPathInfo> {
    return this.request<PeerPathInfo>("getPeerPath", { host });
  }

  private async request<T>(method: string, params?: unknown): Promise<T> {
    await this.ensureStarted();
    const id = randomUUID();
    const payload: SidecarRequest = { id, method, params };

    const child = this.process;
    if (!child) {
      throw new Error(this.lastStartError ?? "NomadVNC sidecar is not running");
    }

    return new Promise<T>((resolve, reject) => {
      const timeoutMs = this.requestTimeoutMs(method);
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`NomadVNC sidecar did not answer ${method} within ${Math.round(timeoutMs / 1000)}s`));
        }
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(`${JSON.stringify(payload)}\n`);
    });
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;

    while (true) {
      const boundary = this.buffer.indexOf("\n");
      if (boundary === -1) {
        return;
      }

      const line = this.buffer.slice(0, boundary).trim();
      this.buffer = this.buffer.slice(boundary + 1);

      if (!line) {
        continue;
      }

      let message: SidecarResponse;
      try {
        message = JSON.parse(line) as SidecarResponse;
      } catch (error) {
        this.emit("event", {
          type: "error",
          scope: "tailnet",
          message: error instanceof Error ? error.message : "Failed to parse sidecar output",
        } satisfies NomadNativeEvent);
        continue;
      }

      if (message.event) {
        this.emit("event", normalizeSidecarEvent(message.event));
        continue;
      }

      const pending = this.pending.get(message.id);
      if (!pending) {
        continue;
      }

      this.pending.delete(message.id);
      if (message.ok) {
        pending.resolve(message.result);
      } else {
        pending.reject(new Error(message.error ?? "Unknown sidecar error"));
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}
