import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response, Router } from "express";

/**
 * Express 4 does not catch rejected promises from async handlers: the
 * request hangs and Node's default unhandled-rejection mode kills the
 * process. Every async route goes through this wrapper so a thrown DB or
 * crypto error reaches the JSON error handler instead.
 */
export function asyncRoute<Req extends Request = Request>(
  handler: (req: Req, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req as Req, res, next).catch(next);
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Route params that are Postgres uuids. A malformed id would otherwise
 * surface as a 22P02 query error (500); answer the same 404 a missing row
 * gets so ids can't be probed for format either.
 */
export function requireUuidParams(router: Router, ...names: string[]): void {
  for (const name of names) {
    router.param(name, (_req, res, next, value: string) => {
      if (!UUID_RE.test(value)) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      next();
    });
  }
}

/** Final JSON error handler: never leaks stack traces or SQL to clients. */
export const jsonErrorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  const err = error as { type?: string; code?: string; message?: string; status?: number };
  if (err.type === "entity.parse.failed") {
    res.status(400).json({ error: "Malformed JSON body" });
    return;
  }
  if (err.type === "entity.too.large") {
    res.status(413).json({ error: "Request body too large" });
    return;
  }
  // Postgres unique_violation: a concurrent insert won the race.
  if (err.code === "23505") {
    res.status(409).json({ error: "Conflict: that record already exists" });
    return;
  }
  console.error(`${req.method} ${req.path} failed: ${err.message ?? String(error)}`);
  res.status(500).json({ error: "Internal server error" });
};
