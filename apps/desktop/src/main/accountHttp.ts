import type { AccountHttpRequest, AccountHttpResponse } from "@nomadvnc/platform-contracts";

/**
 * Account-backend HTTP from the main process.
 *
 * The renderer can't call the account server itself: its CSP allows only
 * loopback `connect-src` (and must stay that way), and a `file://` page
 * has an opaque origin no CORS policy can sensibly allow. The renderer's
 * `AccountClient` hands each request here over IPC instead. Input is
 * validated because it crosses the IPC boundary: http(s) only, a fixed
 * method set, and only the two headers the API uses.
 */

const METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);
const ALLOWED_HEADERS = new Set(["content-type", "authorization"]);
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_BODY_CHARS = 1_000_000;

export type AccountFetch = (url: string, init: RequestInit) => Promise<Response>;

export function validateAccountRequest(input: unknown): AccountHttpRequest {
  if (!input || typeof input !== "object") {
    throw new Error("Invalid account request");
  }
  const candidate = input as Partial<AccountHttpRequest>;
  if (typeof candidate.url !== "string") {
    throw new Error("Invalid account request URL");
  }
  let url: URL;
  try {
    url = new URL(candidate.url);
  } catch {
    throw new Error("Invalid account request URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Account server URL must be http or https");
  }
  if (typeof candidate.method !== "string" || !METHODS.has(candidate.method)) {
    throw new Error("Unsupported account request method");
  }
  const headers: Record<string, string> = {};
  if (candidate.headers && typeof candidate.headers === "object") {
    for (const [name, value] of Object.entries(candidate.headers)) {
      if (ALLOWED_HEADERS.has(name.toLowerCase()) && typeof value === "string") {
        headers[name] = value;
      }
    }
  }
  if (candidate.body !== undefined && (typeof candidate.body !== "string" || candidate.body.length > MAX_BODY_CHARS)) {
    throw new Error("Invalid account request body");
  }
  return { url: url.toString(), method: candidate.method, headers, body: candidate.body };
}

export async function performAccountRequest(input: unknown, fetchFn: AccountFetch): Promise<AccountHttpResponse> {
  const request = validateAccountRequest(input);
  const response = await fetchFn(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = await response.text();
  return { status: response.status, body: body.length > MAX_BODY_CHARS ? "" : body };
}
