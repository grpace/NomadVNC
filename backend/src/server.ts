import express from "express";
import type { BackendConfig } from "./config.js";
import { type DataKey } from "./crypto.js";
import type { DbClient } from "./db.js";
import { jsonErrorHandler } from "./http.js";
import type { Mailer } from "./mailer.js";
import { magicLinkUrl } from "./mailer.js";
import { createAccountRouter } from "./routes/account.js";
import { createAuthRouter } from "./routes/auth.js";
import { createDevicesRouter } from "./routes/devices.js";
import { createSharesRouter } from "./routes/shares.js";
import { isSignInToken, renderSignInOpenError, renderSignInOpenPage } from "./signInOpen.js";

export interface AppDeps {
  config: BackendConfig;
  db: DbClient;
  mailer: Mailer;
  keys?: DataKey[];
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", deps.config.trustProxy ?? false);
  app.use(express.json({ limit: "64kb" }));

  if (deps.config.corsOrigin !== "") {
    app.use((req, res, next) => {
      res.setHeader("Access-Control-Allow-Origin", deps.config.corsOrigin);
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
      }
      next();
    });
  }

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // Click target for sign-in emails. Webmail will not open nomadvnc://
  // directly; this page does, after the user follows an https link.
  app.get("/auth/open", (req, res) => {
    const token = typeof req.query.token === "string" ? req.query.token : "";
    const html = isSignInToken(token) ? renderSignInOpenPage(magicLinkUrl(token)) : renderSignInOpenError();
    res
      .status(isSignInToken(token) ? 200 : 400)
      .set({
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Robots-Tag": "noindex",
      })
      .send(html);
  });

  app.use("/api/v1/auth", createAuthRouter(deps));
  app.use("/api/v1/account", createAccountRouter(deps));
  app.use("/api/v1/devices", createDevicesRouter({ ...deps, keys: deps.keys ?? [] }));
  app.use("/api/v1/devices", createSharesRouter({ ...deps, keys: deps.keys ?? [] }));

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  app.use(jsonErrorHandler);

  return app;
}
