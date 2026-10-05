import { describe, expect, it } from "vitest";
import { describeKeyExpiry, formatDaysLeft } from "./keyExpiry";

const DAY = 86_400_000;
const NOW = new Date("2026-09-09T12:00:00Z").getTime();

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

describe("describeKeyExpiry", () => {
  it("is unknown without a timestamp", () => {
    expect(describeKeyExpiry(undefined, NOW)).toEqual({ status: "unknown", daysLeft: null });
    expect(describeKeyExpiry("", NOW)).toEqual({ status: "unknown", daysLeft: null });
    expect(describeKeyExpiry("not-a-date", NOW)).toEqual({ status: "unknown", daysLeft: null });
  });

  it("flags expired keys", () => {
    expect(describeKeyExpiry(iso(-2 * DAY), NOW)).toEqual({ status: "expired", daysLeft: -2 });
  });

  it("warns within the 7-day window, boundary inclusive", () => {
    expect(describeKeyExpiry(iso(7 * DAY), NOW).status).toBe("expiringSoon");
    expect(describeKeyExpiry(iso(3 * DAY), NOW)).toEqual({ status: "expiringSoon", daysLeft: 3 });
    expect(describeKeyExpiry(iso(0), NOW)).toEqual({ status: "expiringSoon", daysLeft: 0 });
  });

  it("stays quiet for distant expiries", () => {
    expect(describeKeyExpiry(iso(8 * DAY), NOW)).toEqual({ status: "valid", daysLeft: 8 });
    expect(describeKeyExpiry(iso(90 * DAY), NOW).status).toBe("valid");
  });
});

describe("formatDaysLeft", () => {
  it("formats day counts for banner copy", () => {
    expect(formatDaysLeft(0)).toBe("today");
    expect(formatDaysLeft(-5)).toBe("today");
    expect(formatDaysLeft(1)).toBe("1 day");
    expect(formatDaysLeft(4)).toBe("4 days");
  });
});
