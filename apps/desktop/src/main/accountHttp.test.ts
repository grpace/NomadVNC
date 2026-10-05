import { describe, expect, it, vi } from "vitest";
import { performAccountRequest, validateAccountRequest } from "./accountHttp";

describe("validateAccountRequest", () => {
  it("accepts an https API call and keeps only the allowed headers", () => {
    const request = validateAccountRequest({
      url: "https://api.example.test/api/v1/devices",
      method: "GET",
      headers: { Authorization: "Bearer t", "Content-Type": "application/json", Cookie: "nope", "X-Evil": "1" },
    });
    expect(request.headers).toEqual({ Authorization: "Bearer t", "Content-Type": "application/json" });
  });

  it("rejects non-http schemes, unknown methods, and malformed input", () => {
    expect(() => validateAccountRequest({ url: "file:///etc/passwd", method: "GET", headers: {} })).toThrow(/http/);
    expect(() => validateAccountRequest({ url: "https://a.test", method: "PATCH", headers: {} })).toThrow(/method/);
    expect(() => validateAccountRequest({ url: "not a url", method: "GET", headers: {} })).toThrow(/URL/);
    expect(() => validateAccountRequest(null)).toThrow();
    expect(() =>
      validateAccountRequest({ url: "https://a.test", method: "POST", headers: {}, body: { not: "a string" } }),
    ).toThrow(/body/);
  });
});

describe("performAccountRequest", () => {
  it("forwards the request and returns status plus body text", async () => {
    const fetchFn = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const result = await performAccountRequest(
      { url: "https://api.example.test/api/v1/auth/magic-link", method: "POST", headers: {}, body: '{"email":"a@b.c"}' },
      fetchFn,
    );
    expect(result).toEqual({ status: 200, body: '{"ok":true}' });
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.test/api/v1/auth/magic-link");
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("surfaces network failures as rejections", async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      performAccountRequest({ url: "https://down.example.test/health", method: "GET", headers: {} }, fetchFn),
    ).rejects.toThrow("fetch failed");
  });
});
