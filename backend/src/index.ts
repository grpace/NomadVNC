import { loadConfig } from "./config.js";
import { ensureDataKeys } from "./crypto.js";
import { createPool } from "./db.js";
import { createMailer } from "./mailer.js";
import { createApp } from "./server.js";

const config = loadConfig();
if (config.jwtSecret.length < 32) {
  console.warn("JWT_SECRET is shorter than 32 characters; use 32+ random bytes in production.");
}
const pool = createPool(config.databaseUrl);
const mailer = createMailer(config);
const transport = config.mailTransport ?? "none";
if (transport === "none") {
  console.warn("No mail transport configured: sign-in emails can't be sent. Set SMTP_HOST, POSTAL_API_KEY, or MAIL_TRANSPORT=log.");
} else if (transport === "log") {
  console.warn("MAIL_TRANSPORT=log: sign-in links are printed to this log. Anyone with log access can sign in as any user.");
} else {
  console.log(`mail transport: ${transport}`);
}
const keys = config.dataKeys.length > 0 ? await ensureDataKeys(pool, config.dataKeys) : [];
const app = createApp({ config, db: pool, mailer, keys });

const server = app.listen(config.port, "0.0.0.0", () => {
  console.log(`nomadvnc-backend listening on :${config.port}`);
});

// Container stop / redeploy sends SIGTERM: finish in-flight
// requests and release DB connections instead of dropping them mid-query.
let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`${signal} received, shutting down`);
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  server.close(() => {
    void pool.end().finally(() => process.exit(0));
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
