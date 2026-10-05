import express, { Router, type Request, type Response } from "express";
import type { BackendConfig } from "../config.js";
import type { DbClient } from "../db.js";
import { asyncRoute } from "../http.js";
import { createRequireAuth } from "../jwt.js";
import { escapeHtml, sendAccountDeletionEmail, type Mailer } from "../mailer.js";
import { createRateLimiter } from "../rateLimit.js";
import {
  generateOpaqueToken,
  hashOpaqueToken,
  honeypotFilled,
  isValidEmail,
  normalizeEmail,
  padResponse,
} from "../tokens.js";

export interface AccountDeps {
  config: BackendConfig;
  db: DbClient;
  mailer: Mailer;
}

const DELETION_LINK_MINUTES = 60;

/**
 * Deletes a user and everything tied to them: sign-in links, saved
 * machines and their encrypted passwords, shares they created (and any
 * attached tailnet keys), and shares other people made to their email.
 */
export async function deleteAccount(db: DbClient, userId: string): Promise<boolean> {
  await db.query(
    "DELETE FROM shares WHERE grantee_email = (SELECT email FROM users WHERE id = $1)",
    [userId],
  );
  const deleted = await db.query<{ id: string }>("DELETE FROM users WHERE id = $1 RETURNING id", [userId]);
  return deleted.rows.length > 0;
}

/** Small self-contained HTML page for the browser-based deletion flow. */
function page(res: Response, status: number, title: string, body: string): void {
  res
    .status(status)
    .set({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
    })
    .send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)} · NomadVNC</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { max-width: 34rem; margin: 12vh auto; padding: 0 1.25rem; line-height: 1.55; }
  h1 { font-size: 1.4rem; }
  button { font: inherit; padding: .65rem 1.2rem; border-radius: .6rem; border: 0; background: #c93c37; color: #fff; cursor: pointer; }
  p.muted { color: GrayText; font-size: .92rem; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>`);
}

function wantsHtml(req: Request): boolean {
  return req.is("application/x-www-form-urlencoded") === "application/x-www-form-urlencoded";
}

function baseUrl(config: BackendConfig, req: Request): string {
  return config.publicAppUrl || `${req.protocol}://${req.get("host") ?? "localhost"}`;
}

export function createAccountRouter(deps: AccountDeps): Router {
  const { config, db, mailer } = deps;
  const router = Router();
  const requestLimiter = createRateLimiter({ windowMs: 10 * 60_000, max: 10 });
  const confirmLimiter = createRateLimiter({ windowMs: 10 * 60_000, max: 20 });
  // The web flow posts plain HTML forms (no JavaScript, no CORS needed).
  router.use(express.urlencoded({ extended: false, limit: "4kb" }));

  /** In-app deletion: the signed-in user deletes their own account. */
  router.delete(
    "/",
    createRequireAuth(config, db),
    asyncRoute(async (req: Request, res: Response) => {
      const user = (req as Request & { user?: { sub: string } }).user;
      if (!user) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }
      await deleteAccount(db, user.sub);
      res.json({ ok: true });
    }),
  );

  /**
   * Web deletion, step 1: email a confirmation link. Same answer whether
   * or not the address has an account; never creates one.
   */
  router.post(
    "/deletion-request",
    requestLimiter,
    asyncRoute(async (req: Request, res: Response) => {
      const startedAt = Date.now();
      const email = normalizeEmail((req.body as Record<string, unknown>).email);
      if (!honeypotFilled(req.body) && isValidEmail(email)) {
        try {
          const found = await db.query<{ id: string }>("SELECT id FROM users WHERE email = $1", [email]);
          const user = found.rows[0];
          if (user) {
            const token = generateOpaqueToken();
            const expiresAt = new Date(Date.now() + DELETION_LINK_MINUTES * 60_000).toISOString();
            await db.query(
              "INSERT INTO magic_links (user_id, token_hash, expires_at, purpose) VALUES ($1, $2, $3, $4)",
              [user.id, hashOpaqueToken(token), expiresAt, "delete"],
            );
            const url = `${baseUrl(config, req)}/api/v1/account/delete?token=${encodeURIComponent(token)}`;
            const sent = await sendAccountDeletionEmail(mailer, email, url, DELETION_LINK_MINUTES);
            if (!sent.ok) {
              console.warn(`account-deletion mail failed for ${email}: ${sent.error}`);
            }
          }
        } catch (error) {
          console.warn(`account-deletion request failed: ${error instanceof Error ? error.message : error}`);
        }
      }
      await padResponse(startedAt);
      if (wantsHtml(req)) {
        page(
          res,
          200,
          "Check your email",
          `<p>If a NomadVNC account uses that address, we've sent it a link to confirm the deletion. The link expires in ${DELETION_LINK_MINUTES} minutes.</p>
<p class="muted">Nothing is deleted until you open the link and confirm.</p>`,
        );
        return;
      }
      res.json({ ok: true });
    }),
  );

  /**
   * Web deletion, step 2: a confirm page. GET never deletes — mail
   * scanners open links — it only shows the button that POSTs.
   */
  router.get("/delete", (req: Request, res: Response) => {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (!token) {
      page(res, 400, "Link Incomplete", "<p>Open the link from the email again, or request a new one.</p>");
      return;
    }
    page(
      res,
      200,
      "Delete Your NomadVNC Account?",
      `<p>This permanently deletes your account, the machines you synced, their saved passwords, and your shares. It can't be undone.</p>
<p class="muted">Apps signed in to this account are signed out. Machines saved only on a device (local mode) aren't affected.</p>
<form method="post" action="delete">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<button type="submit">Delete My Account</button>
</form>`,
    );
  });

  /** Web deletion, step 3: redeem the single-use deletion link. */
  router.post(
    "/delete",
    confirmLimiter,
    asyncRoute(async (req: Request, res: Response) => {
      const token = String((req.body as Record<string, unknown>).token ?? "");
      const claimed = token
        ? await db.query<{ user_id: string }>(
            `UPDATE magic_links SET consumed_at = now()
             WHERE token_hash = $1 AND purpose = $2 AND consumed_at IS NULL AND expires_at > now()
             RETURNING user_id`,
            [hashOpaqueToken(token), "delete"],
          )
        : { rows: [] };
      const link = claimed.rows[0];
      if (!link) {
        page(res, 400, "Link Expired", "<p>This link has expired or was already used. Request a new one if you still want to delete your account.</p>");
        return;
      }
      await deleteAccount(db, link.user_id);
      page(res, 200, "Account Deleted", "<p>Your NomadVNC account and its synced data have been deleted.</p>");
    }),
  );

  return router;
}
