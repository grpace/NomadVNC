import crypto from "node:crypto";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HONEYPOT_KEYS = ["website", "company", "url", "homepage"];

export function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isValidEmail(email: string): boolean {
  return email !== "" && EMAIL_RE.test(email);
}

/** Opaque single-use token (magic link); only the hash is stored. */
export function generateOpaqueToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function hashOpaqueToken(token: string): string {
  return crypto.createHash("sha256").update(String(token), "utf8").digest("hex");
}

export function honeypotFilled(body: unknown): boolean {
  if (!body || typeof body !== "object") {
    return false;
  }
  return HONEYPOT_KEYS.some((key) => {
    const value = (body as Record<string, unknown>)[key];
    return typeof value === "string" && value.trim() !== "";
  });
}

/** Floor slow auth responses so valid/invalid emails take similar time. */
export async function padResponse(startedAt: number, minMs = 400): Promise<void> {
  const elapsed = Date.now() - startedAt;
  if (elapsed < minMs) {
    await new Promise((resolve) => setTimeout(resolve, minMs - elapsed));
  }
}
