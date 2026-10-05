import type { NextFunction, Request, Response } from "express";

/** Tiny in-memory sliding-window limiter for auth endpoints (per process). */
export function createRateLimiter(options: { windowMs: number; max: number }) {
  const hits = new Map<string, number[]>();
  const keyFor = (req: Request): string => `${req.ip ?? "unknown"}:${req.path}`;
  let lastSweep = Date.now();

  /** Drops keys with no hits in the window so one-off clients don't accumulate forever. */
  function sweep(now: number, windowStart: number): void {
    lastSweep = now;
    for (const [key, times] of hits) {
      if (!times.some((at) => at > windowStart)) {
        hits.delete(key);
      }
    }
  }

  function middleware(req: Request, res: Response, next: NextFunction): void {
    const now = Date.now();
    const key = keyFor(req);
    const windowStart = now - options.windowMs;
    if (now - lastSweep > options.windowMs) {
      sweep(now, windowStart);
    }
    const recent = (hits.get(key) ?? []).filter((at) => at > windowStart);
    if (recent.length >= options.max) {
      res.status(429).json({ error: "Too many requests, try again later" });
      return;
    }
    recent.push(now);
    hits.set(key, recent);
    next();
  }

  // Test seam: reset between cases (separate limiter per app instance anyway).
  (middleware as { reset?: () => void }).reset = () => hits.clear();
  (middleware as { size?: () => number }).size = () => hits.size;
  return middleware;
}
