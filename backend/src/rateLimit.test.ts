import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseTrustProxy } from "./config.js";
import { createRateLimiter } from "./rateLimit.js";

function appWith(limiter: ReturnType<typeof createRateLimiter>, trustProxy: boolean | number | string = false) {
  const app = express();
  app.set("trust proxy", trustProxy);
  app.get("/limited", limiter, (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe("createRateLimiter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("throttles one client after max hits in the window", async () => {
    const app = appWith(createRateLimiter({ windowMs: 60_000, max: 2 }));
    expect((await request(app).get("/limited")).status).toBe(200);
    expect((await request(app).get("/limited")).status).toBe(200);
    expect((await request(app).get("/limited")).status).toBe(429);
  });

  it("buckets per client IP when a reverse proxy is trusted", async () => {
    const app = appWith(createRateLimiter({ windowMs: 60_000, max: 1 }), 1);
    const as = (ip: string) => request(app).get("/limited").set("X-Forwarded-For", ip);
    expect((await as("203.0.113.1")).status).toBe(200);
    expect((await as("203.0.113.2")).status).toBe(200);
    expect((await as("203.0.113.1")).status).toBe(429);
  });

  it("ignores spoofed X-Forwarded-For when no proxy is trusted", async () => {
    const app = appWith(createRateLimiter({ windowMs: 60_000, max: 1 }));
    expect((await request(app).get("/limited").set("X-Forwarded-For", "203.0.113.1")).status).toBe(200);
    expect((await request(app).get("/limited").set("X-Forwarded-For", "203.0.113.2")).status).toBe(429);
  });

  it("forgets idle clients once their window passes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const limiter = createRateLimiter({ windowMs: 1_000, max: 5 });
    const app = appWith(limiter, 1);
    for (const ip of ["198.51.100.1", "198.51.100.2", "198.51.100.3"]) {
      await request(app).get("/limited").set("X-Forwarded-For", ip);
    }
    const size = (limiter as unknown as { size: () => number }).size;
    expect(size()).toBe(3);
    vi.setSystemTime(Date.now() + 5_000);
    await request(app).get("/limited").set("X-Forwarded-For", "198.51.100.9");
    expect(size()).toBe(1);
  });
});

describe("parseTrustProxy", () => {
  it("maps env strings to Express trust-proxy values", () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy("")).toBe(false);
    expect(parseTrustProxy("false")).toBe(false);
    expect(parseTrustProxy("true")).toBe(true);
    expect(parseTrustProxy("1")).toBe(1);
    expect(parseTrustProxy("loopback, uniquelocal")).toBe("loopback, uniquelocal");
  });
});
