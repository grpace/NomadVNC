import { describe, expect, it } from "vitest";
import { isWebUrl, signInUrlFor } from "./tailnetSignIn";

describe("signInUrlFor", () => {
  it("returns the auth URL while logged out", () => {
    expect(signInUrlFor({ loggedIn: false, authUrl: "https://login.tailscale.com/a/abc" })).toBe(
      "https://login.tailscale.com/a/abc",
    );
  });

  it("returns null once logged in or when no URL is pending", () => {
    expect(signInUrlFor({ loggedIn: true, authUrl: "https://login.tailscale.com/a/abc" })).toBeNull();
    expect(signInUrlFor({ loggedIn: false })).toBeNull();
    expect(signInUrlFor(null)).toBeNull();
  });

  it("never hands non-web schemes to the OS", () => {
    expect(signInUrlFor({ loggedIn: false, authUrl: "intent://evil#Intent;end" })).toBeNull();
    expect(isWebUrl("javascript:alert(1)")).toBe(false);
    expect(isWebUrl("http://headscale.lan/register/x")).toBe(true);
  });
});
