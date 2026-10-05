/** Days before expiry at which the UI starts nudging for re-authentication. */
export const KEY_EXPIRY_WARNING_DAYS = 7;

export type KeyExpiryStatus = "expired" | "expiringSoon" | "valid" | "unknown";

export interface KeyExpiryInfo {
  status: KeyExpiryStatus;
  /** Whole days until expiry; negative when expired, null when unknown. */
  daysLeft: number | null;
}

/**
 * Interprets the RFC3339 `keyExpiry` surfaced on TailnetState. Pure and
 * easily tested; the UI decides how loudly to nudge from `status`.
 */
export function describeKeyExpiry(
  keyExpiry: string | undefined,
  nowMs: number = Date.now(),
): KeyExpiryInfo {
  if (!keyExpiry) {
    return { status: "unknown", daysLeft: null };
  }
  const expiryMs = Date.parse(keyExpiry);
  if (Number.isNaN(expiryMs)) {
    return { status: "unknown", daysLeft: null };
  }
  const daysLeft = Math.floor((expiryMs - nowMs) / 86_400_000);
  if (daysLeft < 0) {
    return { status: "expired", daysLeft };
  }
  if (daysLeft <= KEY_EXPIRY_WARNING_DAYS) {
    return { status: "expiringSoon", daysLeft };
  }
  return { status: "valid", daysLeft };
}

/** "3 days" / "1 day" / "today" for banner copy. */
export function formatDaysLeft(daysLeft: number): string {
  if (daysLeft <= 0) {
    return "today";
  }
  return daysLeft === 1 ? "1 day" : `${daysLeft} days`;
}
