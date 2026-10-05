import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import type { BackendConfig } from "./config.js";
import type { DbClient } from "./db.js";

export interface SessionUser {
  id: string;
  email: string;
  credential_version: number;
}

interface TokenPayload {
  sub: string;
  email: string;
  cv: number;
  iat: number;
  exp: number;
}

export function signToken(config: BackendConfig, user: { id: string; email: string; credential_version?: number }): string {
  const cv = Number(user.credential_version ?? 1);
  return jwt.sign(
    { sub: user.id, email: user.email, cv: Number.isFinite(cv) ? cv : 1 },
    config.jwtSecret,
    { algorithm: "HS256", expiresIn: config.jwtExpiresIn } as jwt.SignOptions,
  );
}

export function createRequireAuth(config: BackendConfig, db: DbClient) {
  return async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    try {
      const payload = jwt.verify(header.slice(7), config.jwtSecret, {
        algorithms: ["HS256"],
      }) as TokenPayload;
      const result = await db.query<{ credential_version: number }>(
        "SELECT credential_version FROM users WHERE id = $1",
        [payload.sub],
      );
      const row = result.rows[0];
      if (!row || Number(row.credential_version) !== Number(payload.cv ?? 1)) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      (req as Request & { user?: TokenPayload }).user = payload;
      next();
    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        res.status(401).json({ error: "Token expired" });
        return;
      }
      res.status(401).json({ error: "Invalid token" });
    }
  };
}
