import { Router, type Request, type Response } from "express";
import type { BackendConfig } from "../config.js";
import type { DbClient } from "../db.js";
import { asyncRoute } from "../http.js";
import { createRequireAuth, createSession, signToken, type TokenPayload } from "../jwt.js";
import { sendMagicLinkEmail, type Mailer } from "../mailer.js";
import { createRateLimiter } from "../rateLimit.js";
import {
  generateOpaqueToken,
  hashOpaqueToken,
  honeypotFilled,
  isValidEmail,
  normalizeEmail,
  padResponse,
} from "../tokens.js";
import type { SessionUser } from "../jwt.js";

export interface AuthDeps {
  config: BackendConfig;
  db: DbClient;
  mailer: Mailer;
}

const GENERIC_OK = { ok: true };

export function createAuthRouter(deps: AuthDeps): Router {
  const { config, db, mailer } = deps;
  const router = Router();
  const requestLimiter = createRateLimiter({ windowMs: 10 * 60_000, max: 10 });

  router.post("/magic-link", requestLimiter, asyncRoute(async (req: Request, res: Response) => {
    const startedAt = Date.now();
    // Always generic: never reveal whether an address has an account.
    if (honeypotFilled(req.body)) {
      await padResponse(startedAt);
      res.json(GENERIC_OK);
      return;
    }
    const email = normalizeEmail((req.body as Record<string, unknown>).email);
    if (!isValidEmail(email)) {
      await padResponse(startedAt);
      res.json(GENERIC_OK);
      return;
    }
    try {
      const existing = await db.query<SessionUser>(
        "SELECT id, email, credential_version FROM users WHERE email = $1",
        [email],
      );
      let user = existing.rows[0];
      if (!user) {
        const created = await db.query<SessionUser>(
          "INSERT INTO users (email) VALUES ($1) ON CONFLICT (email) DO UPDATE SET updated_at = now() RETURNING id, email, credential_version",
          [email],
        );
        user = created.rows[0] as SessionUser;
      }
      const token = generateOpaqueToken();
      const expiresAt = new Date(Date.now() + config.magicLinkTtlMinutes * 60_000).toISOString();
      await db.query(
        "INSERT INTO magic_links (user_id, token_hash, expires_at, purpose) VALUES ($1, $2, $3, $4)",
        [user.id, hashOpaqueToken(token), expiresAt, "signin"],
      );
      const publicBase = config.publicAppUrl || `${req.protocol}://${req.get("host") ?? "localhost"}`;
      const sent = await sendMagicLinkEmail(mailer, config, email, token, publicBase);
      if (!sent.ok) {
        console.warn(`magic-link mail failed for ${email}: ${sent.error}`);
      }
    } catch (error) {
      console.warn(`magic-link request failed: ${error instanceof Error ? error.message : error}`);
    }
    await padResponse(startedAt);
    res.json(GENERIC_OK);
  }));

  router.post("/consume", asyncRoute(async (req: Request, res: Response) => {
    const token = String((req.body as Record<string, unknown>).token ?? "");
    if (!token) {
      res.status(401).json({ error: "Invalid or expired link" });
      return;
    }
    // Single atomic claim: check-then-update would let two concurrent
    // requests redeem the same link.
    const claimed = await db.query<{ user_id: string }>(
      `UPDATE magic_links SET consumed_at = now()
       WHERE token_hash = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now()
       RETURNING user_id`,
      [hashOpaqueToken(token), "signin"],
    );
    const link = claimed.rows[0];
    if (!link) {
      res.status(401).json({ error: "Invalid or expired link" });
      return;
    }
    const userResult = await db.query<SessionUser>(
      "SELECT id, email, credential_version FROM users WHERE id = $1",
      [link.user_id],
    );
    const user = userResult.rows[0];
    if (!user) {
      res.status(401).json({ error: "Invalid or expired link" });
      return;
    }
    res.json({ token: signToken(config, user, await createSession(db, user.id)) });
  }));

  // Sliding session: a signed-in app trades its still-valid token for a
  // fresh one, so it stays signed in as long as it is opened now and then.
  // The device keeps its session; a token from before sessions existed
  // gets one here, so signing out later affects only that device.
  router.post("/refresh", createRequireAuth(config, db), asyncRoute(async (req: Request, res: Response) => {
    const user = (req as Request & { user?: TokenPayload }).user;
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    let sessionId = user.sid;
    if (sessionId) {
      await db.query("UPDATE sessions SET last_used_at = now() WHERE id = $1", [sessionId]);
    } else {
      sessionId = await createSession(db, user.sub);
    }
    res.json({
      token: signToken(config, { id: user.sub, email: user.email, credential_version: user.cv }, sessionId),
    });
  }));

  // Signs out this device only. A token from before sessions existed has
  // no session to revoke: the app deletes it, and it stays valid until it
  // expires. Apps renew into a session within 12 hours of being opened, so
  // that only covers tokens not renewed since this change.
  router.post("/logout", createRequireAuth(config, db), asyncRoute(async (req: Request, res: Response) => {
    const user = (req as Request & { user?: TokenPayload }).user;
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (user.sid) {
      await db.query("UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2", [user.sid, user.sub]);
    }
    res.json(GENERIC_OK);
  }));

  // Signs out every device, e.g. after losing a phone. Bumping the
  // credential version ends every token, with or without a session.
  router.post("/logout-all", createRequireAuth(config, db), asyncRoute(async (req: Request, res: Response) => {
    const user = (req as Request & { user?: TokenPayload }).user;
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    await db.query("UPDATE users SET credential_version = credential_version + 1, updated_at = now() WHERE id = $1", [
      user.sub,
    ]);
    await db.query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [user.sub]);
    res.json(GENERIC_OK);
  }));

  return router;
}
