import type { PeerPathInfo } from "@nomadvnc/platform-contracts";

/** Quality applied to the static image once input stops (TurboVNC lesson). */
export const IDLE_BOOST_QUALITY = 9;

/**
 * Suggests an adaptive quality ceiling from tailnet path health, or `null`
 * to respect the user's manual setting. Auto never exceeds the manual
 * ceiling — it only degrades on slow links. (The idle boost to
 * {@link IDLE_BOOST_QUALITY} is handled separately by the viewer panel.)
 */
export function suggestAutoQuality(
  path: PeerPathInfo | null | undefined,
  manualCeiling: number,
): number | null {
  if (path === undefined || path === null) {
    return null;
  }
  if (!path.found) {
    return Math.min(manualCeiling, 2);
  }
  if (path.path === "relay") {
    if (typeof path.latencyMs === "number") {
      return Math.min(manualCeiling, path.latencyMs >= 250 ? 2 : 5);
    }
    return Math.min(manualCeiling, 5);
  }
  if (path.path === "direct") {
    if (typeof path.latencyMs === "number" && path.latencyMs >= 120) {
      return Math.min(manualCeiling, 5);
    }
    return null;
  }
  return null;
}

/** Human label for an effective quality value (matches viewer presets). */
export function qualityLabelFor(value: number): string {
  switch (value) {
    case 2:
      return "Low";
    case 5:
      return "Medium";
    case 6:
      return "Auto";
    case 8:
      return "High";
    case 9:
      return "Lossless";
    default:
      return "Custom";
  }
}
