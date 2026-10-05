export interface BackendConfig {
  port: number;
  databaseUrl: string;
  jwtSecret: string;
  jwtExpiresIn: string;
  publicAppUrl: string;
  corsOrigin: string;
  postalApiUrl: string;
  postalApiKey: string;
  /**
   * How sign-in and share emails go out. Defaults from what's configured:
   * SMTP_HOST → smtp, else POSTAL_API_KEY → postal, else none. `log`
   * (explicit only) prints the emails, sign-in links included, to stdout.
   */
  mailTransport?: MailTransport;
  smtp?: SmtpConfig;
  mailFrom: string;
  mailReplyTo: string;
  magicLinkTtlMinutes: number;
  /** Newest last. Empty when credential sync is not configured. */
  dataKeys: string[];
  /**
   * Express `trust proxy` setting. Behind a reverse proxy (Traefik, Caddy, nginx)
   * this must be set (e.g. `1`), or every client shares the proxy's IP and
   * the auth rate limiter throttles all users as one. Unset = no proxy
   * trusted, so X-Forwarded-For can't be spoofed on a directly exposed port.
   */
  trustProxy?: boolean | number | string;
}

export type MailTransport = "smtp" | "postal" | "log" | "none";

export interface SmtpConfig {
  host: string;
  port: number;
  /** Implicit TLS (usually port 465). Otherwise STARTTLS is used when offered. */
  secure: boolean;
  user: string;
  pass: string;
}

const MAIL_TRANSPORTS: readonly MailTransport[] = ["smtp", "postal", "log", "none"];

export function resolveMailTransport(env: NodeJS.ProcessEnv): MailTransport {
  const explicit = env.MAIL_TRANSPORT?.trim().toLowerCase();
  if (explicit) {
    if (!(MAIL_TRANSPORTS as readonly string[]).includes(explicit)) {
      throw new Error(`MAIL_TRANSPORT must be one of ${MAIL_TRANSPORTS.join(", ")} (got "${env.MAIL_TRANSPORT}")`);
    }
    return explicit as MailTransport;
  }
  if (env.SMTP_HOST?.trim()) {
    return "smtp";
  }
  if (env.POSTAL_API_KEY?.trim()) {
    return "postal";
  }
  return "none";
}

/** TRUST_PROXY: unset/"false" → false, "true" → true, digits → hop count, else an Express address list. */
export function parseTrustProxy(raw: string | undefined): boolean | number | string {
  const value = (raw ?? "").trim();
  if (value === "" || value.toLowerCase() === "false") {
    return false;
  }
  if (value.toLowerCase() === "true") {
    return true;
  }
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  return value;
}

function isTrue(raw: string | undefined): boolean {
  return raw?.trim().toLowerCase() === "true";
}

function positiveNumber(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number (got "${raw}")`);
  }
  return value;
}

function required(value: string | undefined, name: string): string {
  if (!value || value.trim() === "") {
    throw new Error(`${name} is not set. See backend/.env.example.`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  return {
    port: positiveNumber(env.PORT, 3200, "PORT"),
    databaseUrl: required(env.DATABASE_URL, "DATABASE_URL"),
    jwtSecret: required(env.JWT_SECRET, "JWT_SECRET"),
    jwtExpiresIn: env.JWT_EXPIRES_IN ?? "24h",
    publicAppUrl: (env.PUBLIC_APP_URL ?? "").replace(/\/+$/, ""),
    corsOrigin: env.CORS_ORIGIN ?? "",
    postalApiUrl: (env.POSTAL_API_URL ?? "").trim().replace(/\/+$/, ""),
    postalApiKey: env.POSTAL_API_KEY?.trim() ?? "",
    mailFrom: env.MAIL_FROM ?? "NomadVNC <notifications@nomadvnc.local>",
    mailReplyTo: env.MAIL_REPLY_TO ?? "",
    magicLinkTtlMinutes: positiveNumber(env.MAGIC_LINK_TTL_MINUTES, 15, "MAGIC_LINK_TTL_MINUTES"),
    dataKeys: [env.DATA_KEY_OLD ?? "", env.DATA_KEY ?? ""].filter((key) => key.trim() !== ""),
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    mailTransport: resolveMailTransport(env),
    smtp: env.SMTP_HOST?.trim()
      ? {
          host: env.SMTP_HOST.trim(),
          port: positiveNumber(env.SMTP_PORT, isTrue(env.SMTP_SECURE) ? 465 : 587, "SMTP_PORT"),
          secure: isTrue(env.SMTP_SECURE),
          user: env.SMTP_USER?.trim() ?? "",
          pass: env.SMTP_PASS ?? "",
        }
      : undefined,
  };
}
