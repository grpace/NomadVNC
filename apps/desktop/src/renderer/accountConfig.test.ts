import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ACCOUNT_BASE_URL,
  isValidAccountBaseUrl,
  loadAccountConfig,
  persistAccountConfig,
} from "./accountConfig";

describe("accountConfig", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("defaults to the hosted backend", () => {
    expect(loadAccountConfig()).toEqual({ baseUrl: DEFAULT_ACCOUNT_BASE_URL });
    expect(DEFAULT_ACCOUNT_BASE_URL).toBe("https://api.nomadvnc.dev.greg.tech");
  });

  it("round-trips a custom server address", () => {
    persistAccountConfig({ baseUrl: "https://api.example.test/" });
    expect(loadAccountConfig()).toEqual({ baseUrl: "https://api.example.test" });
  });

  it("falls back to defaults on corrupt or invalid storage", () => {
    window.localStorage.setItem("nomadvnc.desktop.accountConfig.v1", "not-json");
    expect(loadAccountConfig().baseUrl).toBe(DEFAULT_ACCOUNT_BASE_URL);
    window.localStorage.setItem(
      "nomadvnc.desktop.accountConfig.v1",
      JSON.stringify({ baseUrl: "nota-url" }),
    );
    expect(loadAccountConfig().baseUrl).toBe(DEFAULT_ACCOUNT_BASE_URL);
  });

  it("validates server addresses", () => {
    expect(isValidAccountBaseUrl("http://localhost:3200")).toBe(true);
    expect(isValidAccountBaseUrl("https://api.example.test")).toBe(true);
    expect(isValidAccountBaseUrl("nota-url")).toBe(false);
    expect(isValidAccountBaseUrl("")).toBe(false);
    expect(isValidAccountBaseUrl("http://host/path")).toBe(false);
  });
});
