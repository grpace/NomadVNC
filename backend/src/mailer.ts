import nodemailer from "nodemailer";
import type { BackendConfig, SmtpConfig } from "./config.js";
import { signInOpenUrl } from "./signInOpen.js";

/**
 * Outgoing mail (sign-in links, share invites). Three transports:
 * - smtp: any SMTP server — your own Postfix/Mailcow/Stalwart, or a
 *   provider (Fastmail, SES, Mailgun, Gmail app password, …).
 * - postal: Postal's HTTP API (`POST /api/v1/send/message` with the
 *   `X-Server-API-Key` header), for self-hosted Postal installs.
 * - log: prints each email to stdout instead of sending it. For a
 *   single-user self-host with no mail server: copy the sign-in link from
 *   the logs. Anyone who can read the logs can sign in as anyone.
 */

const SEND_TIMEOUT_MS = 12_000;

export type MailSendResult = { ok: true; messageId?: string } | { ok: false; error: string };

export interface Mailer {
  sendMail(input: { to: string; subject: string; html: string; text: string; tag: string }): Promise<MailSendResult>;
}

/**
 * Custom-protocol deep link the desktop app registers with the OS
 * (`nomadvnc://auth/callback?token=...`). The email itself uses an https
 * link, because webmail will not make this scheme clickable. The https
 * page then opens this URL.
 */
export const MAGIC_LINK_SCHEME = "nomadvnc";

export function magicLinkUrl(token: string): string {
  return `${MAGIC_LINK_SCHEME}://auth/callback?token=${encodeURIComponent(token)}`;
}

function magicLinkEmail(
  deepLink: string,
  clickUrl: string,
  ttlMinutes: number,
): { subject: string; html: string; text: string } {
  const click = escapeHtml(clickUrl);
  const paste = escapeHtml(deepLink);
  return {
    subject: "Sign in to NomadVNC",
    html:
      `<p>Click the button below to sign in to NomadVNC (expires in ${ttlMinutes} minutes):</p>` +
      `<p><a href="${click}" style="display:inline-block;padding:10px 20px;background:#1f6feb;color:#ffffff;text-decoration:none;border-radius:6px;">Sign in to NomadVNC</a></p>` +
      `<p style="color:#666;font-size:13px;">If the button doesn't open the app, copy this link and paste it into the sign-in box in NomadVNC:</p>` +
      `<p style="font-size:13px;word-break:break-all;">${paste}</p>` +
      `<p style="color:#666;font-size:13px;">If you did not request this, ignore it.</p>`,
    text:
      `Sign in to NomadVNC (expires in ${ttlMinutes} minutes):\n${clickUrl}\n\n` +
      `Opening the link signs you in automatically. If it doesn't open the app, copy this link and paste it into the sign-in box in NomadVNC:\n${deepLink}\n\n` +
      `If you did not request this, ignore it.`,
  };
}

function createPostalMailer(config: BackendConfig): Mailer {
  return {
    async sendMail(input): Promise<MailSendResult> {
      if (config.postalApiKey === "" || config.postalApiUrl === "") {
        return { ok: false, error: "Postal is not configured (set POSTAL_API_URL and POSTAL_API_KEY)" };
      }
      const url = `${config.postalApiUrl}/api/v1/send/message`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
      try {
        const res = await fetch(url, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            "X-Server-API-Key": config.postalApiKey,
          },
          body: JSON.stringify({
            to: [input.to],
            from: config.mailFrom,
            reply_to: config.mailReplyTo || undefined,
            subject: input.subject,
            html_body: input.html,
            plain_body: input.text,
            tag: input.tag,
          }),
        });
        const json = (await res.json().catch(() => null)) as
          | { status: string; data?: { message_id?: string; code?: string; message?: string } }
          | null;
        if (!res.ok || !json || json.status !== "success") {
          const detail =
            json && json.status === "error"
              ? json.data?.message || json.data?.code || `HTTP ${res.status}`
              : `HTTP ${res.status}`;
          return { ok: false, error: detail };
        }
        return { ok: true, messageId: json.data?.message_id };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "Mail send failed" };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Minimal nodemailer transport surface (injectable for tests). */
export interface SmtpTransport {
  sendMail(message: {
    from: string;
    to: string;
    replyTo?: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<{ messageId?: string }>;
}

export function createSmtpMailer(
  config: BackendConfig,
  makeTransport: (smtp: SmtpConfig) => SmtpTransport = (smtp) =>
    nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.secure,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
      connectionTimeout: SEND_TIMEOUT_MS,
      greetingTimeout: SEND_TIMEOUT_MS,
      socketTimeout: SEND_TIMEOUT_MS,
    }),
): Mailer {
  const transport = config.smtp ? makeTransport(config.smtp) : null;
  return {
    async sendMail(input): Promise<MailSendResult> {
      if (!transport) {
        return { ok: false, error: "SMTP is not configured (set SMTP_HOST)" };
      }
      try {
        const info = await transport.sendMail({
          from: config.mailFrom,
          to: input.to,
          replyTo: config.mailReplyTo || undefined,
          subject: input.subject,
          text: input.text,
          html: input.html,
        });
        return { ok: true, messageId: info.messageId };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : "SMTP send failed" };
      }
    },
  };
}

export function createLogMailer(log: (line: string) => void = (line) => console.log(line)): Mailer {
  return {
    async sendMail(input): Promise<MailSendResult> {
      log(`[mail:log] to=${input.to} tag=${input.tag} subject="${input.subject}"\n${input.text}`);
      return { ok: true };
    },
  };
}

function createDisabledMailer(): Mailer {
  return {
    async sendMail(): Promise<MailSendResult> {
      return { ok: false, error: "Mail is not configured (set SMTP_HOST, POSTAL_API_KEY, or MAIL_TRANSPORT=log)" };
    },
  };
}

/** Picks the transport from config (see `resolveMailTransport`). */
export function createMailer(config: BackendConfig): Mailer {
  switch (config.mailTransport ?? "none") {
    case "smtp":
      return createSmtpMailer(config);
    case "postal":
      return createPostalMailer(config);
    case "log":
      return createLogMailer();
    case "none":
      return createDisabledMailer();
  }
}

export async function sendMagicLinkEmail(
  mailer: Mailer,
  config: BackendConfig,
  to: string,
  token: string,
  publicBase = config.publicAppUrl,
): Promise<MailSendResult> {
  const deepLink = magicLinkUrl(token);
  // Webmail strips nomadvnc:// hrefs, so the button is https when we know
  // the server's public address. The paste line stays the deep link, which
  // the app accepts directly.
  const clickUrl = publicBase.trim() !== "" ? signInOpenUrl(publicBase, token) : deepLink;
  const email = magicLinkEmail(deepLink, clickUrl, config.magicLinkTtlMinutes);
  return mailer.sendMail({ to, ...email, tag: "magic-link" });
}

/** Confirmation email for deleting an account from the web (no app needed). */
export async function sendAccountDeletionEmail(
  mailer: Mailer,
  to: string,
  confirmUrl: string,
  ttlMinutes: number,
): Promise<MailSendResult> {
  const url = escapeHtml(confirmUrl);
  return mailer.sendMail({
    to,
    subject: "Confirm Deleting Your NomadVNC Account",
    html:
      `<p>Someone, hopefully you, asked to delete the NomadVNC account for this email address.</p>` +
      `<p><a href="${url}">Review and confirm the deletion</a> (the link expires in ${ttlMinutes} minutes).</p>` +
      `<p style="color:#666;font-size:13px;">If you didn't ask for this, ignore this email; nothing will change.</p>`,
    text:
      `Someone, hopefully you, asked to delete the NomadVNC account for this email address.\n\n` +
      `Review and confirm the deletion (the link expires in ${ttlMinutes} minutes):\n${confirmUrl}\n\n` +
      `If you didn't ask for this, ignore this email; nothing will change.`,
    tag: "account-deletion",
  });
}

export interface ShareInviteDetails {
  deviceLabel: string;
  ownerEmail: string;
}

/** Escapes user-controlled text (device labels, emails) for HTML mail bodies. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Strips CR/LF so user text can never fold into extra mail header lines. */
function headerSafe(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function shareInviteEmail(details: ShareInviteDetails): { subject: string; html: string; text: string } {
  // The device label is chosen by any signed-in user and lands in mail from
  // our trusted sender, so it is escaped (never rendered as markup).
  const owner = escapeHtml(details.ownerEmail);
  const label = escapeHtml(details.deviceLabel);
  const subject = headerSafe(`${details.ownerEmail} shared a NomadVNC device with you`);
  const guidance =
    "Sign in to NomadVNC with a Nomad account using this email address and find it under Shared With Me. " +
    "You must already be on the owner's tailnet to reach it; if they attached a tailnet key, it is your connect credential for this device.";
  return {
    subject,
    html: `<p>${owner} shared <strong>${label}</strong> with you on NomadVNC.</p>` + `<p>${escapeHtml(guidance)}</p>`,
    text: `${details.ownerEmail} shared "${details.deviceLabel}" with you on NomadVNC.\n\n${guidance}`,
  };
}

export async function sendShareInviteEmail(
  mailer: Mailer,
  config: BackendConfig,
  to: string,
  details: ShareInviteDetails,
): Promise<MailSendResult> {
  return mailer.sendMail({ to, ...shareInviteEmail(details), tag: "share-invite" });
}
