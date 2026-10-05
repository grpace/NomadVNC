import type { BackendShareView } from "../account/accountClient";

export const SHARE_WARN_WITHIN_DAYS = 7;
export const SHARE_MAX_KEY_DAYS = 90;

export type ShareExpiryTone = "ok" | "warn" | "bad" | "plain";

export interface ShareExpiryLabel {
  text: string;
  tone: ShareExpiryTone;
}

/** Pure share-expiry label (mirrors desktop ShareDialog expiryLabel). */
export function shareExpiryLabel(share: BackendShareView): ShareExpiryLabel {
  if (!share.hasTailnetKey) {
    return { text: "Same-tailnet · never expires", tone: "plain" };
  }
  const days = share.keyExpiresInDays;
  if (days === null) {
    return { text: "Tailnet key attached", tone: "ok" };
  }
  if (days <= 0) {
    return {
      text: "Tailnet key expired. Replace it before the grantee is locked out",
      tone: "bad",
    };
  }
  if (days <= SHARE_WARN_WITHIN_DAYS) {
    return { text: `Tailnet key expires in ${days}d. Replace soon`, tone: "warn" };
  }
  return { text: `Tailnet key expires in ${days}d`, tone: "ok" };
}

/** Pure days-input validation (1–90 whole days). */
export function parseShareDays(raw: string): number | null {
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > SHARE_MAX_KEY_DAYS) {
    return null;
  }
  return days;
}

export function daysToIso(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}
