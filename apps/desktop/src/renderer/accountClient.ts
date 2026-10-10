/**
 * Typed client for the self-hosted NomadVNC account backend
 * (`backend/`, API in `docs/architecture.md`). `fetchFn` is injectable
 * so tests never touch the network; the desktop app passes
 * `createAccountFetch(window.nomadNative)` so requests run in the main
 * process.
 */

import type { AccountHttpRequest, NomadNativePlatform } from "@nomadvnc/platform-contracts";

export interface BackendDeviceView {
  id: string;
  tailscaleStableId: string;
  dnsName?: string;
  lastKnownIp?: string;
  vncPort: number;
  label: string;
  collectionName?: string;
  hasCredential: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BackendDeviceUpsert {
  label: string;
  tailscaleStableId: string;
  dnsName?: string;
  lastKnownIp?: string;
  vncPort: number;
  collectionName?: string;
}

export interface BackendShareView {
  id: string;
  deviceId: string;
  granteeEmail: string;
  permission: string;
  hasTailnetKey: boolean;
  /** Whole days until the attached tailnet key expires; null when no key is attached. */
  keyExpiresInDays: number | null;
  createdAt: string;
}

export interface BackendSharedDeviceView {
  id: string;
  tailscaleStableId: string;
  dnsName?: string;
  lastKnownIp?: string;
  vncPort: number;
  label: string;
  collectionName?: string;
  /** Owner's account email — who granted this. */
  sharedBy: string;
  permission: string;
  /** True when the grant carries a tailnet auth key (key-passing transport). */
  hasTailnetKey: boolean;
  grantedAt: string;
}

export interface ShareGrantInput {
  email: string;
  /** Opaque Tailscale auth key; omit for same-tailnet grants (never expires). */
  tailnetAuthKey?: string;
  /** ISO date; defaults server-side to 30 days when a key is given. */
  keyExpiresAt?: string;
}

export class AccountApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AccountApiError";
  }
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * `fetch` over the desktop bridge: the request runs in the Electron main
 * process (`accountRequest`), because the renderer's CSP only allows
 * loopback connections and a `file://` origin can't pass CORS. Falls back
 * to the global `fetch` when the bridge lacks the method (tests, web).
 */
export function createAccountFetch(
  bridge: Pick<NomadNativePlatform, "accountRequest"> | undefined,
): FetchFn {
  const accountRequest = bridge?.accountRequest;
  if (typeof accountRequest !== "function") {
    return (url, init) => globalThis.fetch(url, init);
  }
  return async (url, init = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      headers[name] = value;
    });
    const method = (init.method ?? "GET").toUpperCase() as AccountHttpRequest["method"];
    const result = await accountRequest({
      url,
      method,
      headers,
      body: typeof init.body === "string" ? init.body : undefined,
    });
    // Null-body statuses must be constructed without a body.
    const nullBody = result.status === 204 || result.status === 205 || result.status === 304;
    return new Response(nullBody ? null : result.body, { status: result.status });
  };
}

export class AccountClient {
  constructor(
    private readonly baseUrl: string,
    private readonly getToken: () => string | null,
    private readonly fetchFn: FetchFn = (url, init) => globalThis.fetch(url, init),
  ) {}

  get authenticated(): boolean {
    return this.getToken() !== null;
  }

  async requestMagicLink(email: string): Promise<void> {
    await this.request("/api/v1/auth/magic-link", {
      method: "POST",
      body: { email },
      auth: false,
    });
  }

  async consumeMagicLink(token: string): Promise<string> {
    const body = await this.request<{ token: string }>("/api/v1/auth/consume", {
      method: "POST",
      body: { token },
      auth: false,
    });
    if (!body.token) {
      throw new AccountApiError(401, "Invalid or expired link");
    }
    return body.token;
  }

  /**
   * Trades the current (still valid) session token for a fresh one. The
   * server keeps sessions short; the app refreshes so the user stays
   * signed in. A 401 means the session is over (expired or revoked).
   */
  async refreshSession(): Promise<string> {
    const body = await this.request<{ token: string }>("/api/v1/auth/refresh", { method: "POST" });
    if (!body.token) {
      throw new AccountApiError(500, "Session refresh returned no token");
    }
    return body.token;
  }

  async logout(): Promise<void> {
    await this.request("/api/v1/auth/logout", { method: "POST" });
  }

  /**
   * Permanently deletes the signed-in account and its synced data
   * (machines, passwords, shares). Every session for it stops working.
   */
  async deleteAccount(): Promise<void> {
    await this.request("/api/v1/account", { method: "DELETE" });
  }

  async listDevices(): Promise<BackendDeviceView[]> {
    const body = await this.request<{ devices: BackendDeviceView[] }>("/api/v1/devices");
    return body.devices ?? [];
  }

  async upsertDevice(input: BackendDeviceUpsert): Promise<BackendDeviceView> {
    const body = await this.request<{ device: BackendDeviceView }>("/api/v1/devices", {
      method: "PUT",
      body: input,
    });
    if (!body.device) {
      throw new AccountApiError(500, "Device sync returned no device");
    }
    return body.device;
  }

  async setDeviceCredential(deviceId: string, password: string): Promise<void> {
    await this.request(`/api/v1/devices/${encodeURIComponent(deviceId)}/credential`, {
      method: "PUT",
      body: { password },
    });
  }

  async deleteDeviceCredential(deviceId: string): Promise<void> {
    try {
      await this.request(`/api/v1/devices/${encodeURIComponent(deviceId)}/credential`, {
        method: "DELETE",
      });
    } catch (error) {
      if (error instanceof AccountApiError && error.status === 404) {
        return;
      }
      throw error;
    }
  }

  async deleteDevice(deviceId: string): Promise<void> {
    try {
      await this.request(`/api/v1/devices/${encodeURIComponent(deviceId)}`, {
        method: "DELETE",
      });
    } catch (error) {
      if (error instanceof AccountApiError && error.status === 404) {
        return;
      }
      throw error;
    }
  }

  async listSharedDevices(): Promise<BackendSharedDeviceView[]> {
    const body = await this.request<{ devices: BackendSharedDeviceView[] }>("/api/v1/devices/shared");
    return body.devices ?? [];
  }

  async listShares(deviceId: string): Promise<BackendShareView[]> {
    const body = await this.request<{ shares: BackendShareView[] }>(
      `/api/v1/devices/${encodeURIComponent(deviceId)}/shares`,
    );
    return body.shares ?? [];
  }

  async createShare(
    deviceId: string,
    input: ShareGrantInput,
  ): Promise<{ share: BackendShareView; inviteSent: boolean }> {
    const body = await this.request<{ share: BackendShareView; inviteSent: boolean }>(
      `/api/v1/devices/${encodeURIComponent(deviceId)}/shares`,
      { method: "POST", body: input },
    );
    if (!body.share) {
      throw new AccountApiError(500, "Share creation returned no grant");
    }
    return { share: body.share, inviteSent: body.inviteSent ?? false };
  }

  async updateShareKey(
    deviceId: string,
    shareId: string,
    input: { tailnetAuthKey: string; keyExpiresAt?: string } | { tailnetAuthKey: null },
  ): Promise<BackendShareView> {
    const body = await this.request<{ share: BackendShareView }>(
      `/api/v1/devices/${encodeURIComponent(deviceId)}/shares/${encodeURIComponent(shareId)}`,
      { method: "PUT", body: input },
    );
    if (!body.share) {
      throw new AccountApiError(500, "Share update returned no grant");
    }
    return body.share;
  }

  async deleteShare(deviceId: string, shareId: string): Promise<void> {
    try {
      await this.request(
        `/api/v1/devices/${encodeURIComponent(deviceId)}/shares/${encodeURIComponent(shareId)}`,
        { method: "DELETE" },
      );
    } catch (error) {
      if (error instanceof AccountApiError && error.status === 404) {
        return;
      }
      throw error;
    }
  }

  async getDeviceCredential(deviceId: string): Promise<string | null> {
    try {
      const body = await this.request<{ password: string }>(
        `/api/v1/devices/${encodeURIComponent(deviceId)}/credential`,
      );
      return body.password ?? null;
    } catch (error) {
      if (error instanceof AccountApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  private async request<T>(
    path: string,
    options: { method?: string; body?: unknown; auth?: boolean } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.auth !== false) {
      const token = this.getToken();
      if (!token) {
        throw new AccountApiError(401, "Not signed in to a Nomad account");
      }
      headers.Authorization = `Bearer ${token}`;
    }
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
        method: options.method ?? "GET",
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    } catch (error) {
      throw new AccountApiError(0, error instanceof Error ? `Account server unreachable: ${error.message}` : "Account server unreachable");
    }
    if (response.status === 204) {
      return undefined as T;
    }
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    if (!response.ok) {
      throw new AccountApiError(response.status, payload?.error ?? `Request failed (${response.status})`);
    }
    return (payload ?? {}) as T;
  }
}
