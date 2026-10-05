import { describe, expect, it, vi } from "vitest";
import { loadConfig, resolveMailTransport, type BackendConfig } from "./config.js";
import {
  MAGIC_LINK_SCHEME,
  createLogMailer,
  createMailer,
  createSmtpMailer,
  escapeHtml,
  magicLinkUrl,
  sendMagicLinkEmail,
  sendShareInviteEmail,
  type Mailer,
} from "./mailer.js";

function testConfig(): BackendConfig {
  return {
    port: 3200,
    databaseUrl: "postgres://localhost/test",
    jwtSecret: "test-secret",
    jwtExpiresIn: "24h",
    publicAppUrl: "",
    corsOrigin: "",
    postalApiUrl: "https://postal.example",
    postalApiKey: "key",
    mailFrom: "NomadVNC <notifications@example.com>",
    mailReplyTo: "",
    magicLinkTtlMinutes: 15,
    dataKeys: [],
  };
}

describe("magicLinkUrl", () => {
  it("builds a nomadvnc:// deep link carrying the token", () => {
    expect(magicLinkUrl("abc123")).toBe(`${MAGIC_LINK_SCHEME}://auth/callback?token=abc123`);
  });

  it("URL-encodes the token", () => {
    const url = magicLinkUrl("a+b/c=d");
    expect(url).toBe(`${MAGIC_LINK_SCHEME}://auth/callback?token=a%2Bb%2Fc%3Dd`);
  });

  it("produces a URL the desktop parser accepts", () => {
    const parsed = new URL(magicLinkUrl("tok_123-xyz"));
    expect(parsed.protocol).toBe(`${MAGIC_LINK_SCHEME}:`);
    expect(parsed.searchParams.get("token")).toBe("tok_123-xyz");
  });
});

describe("sendMagicLinkEmail", () => {
  it("puts an https button in the email and keeps the deep link for paste", async () => {
    const sent: { to: string; subject: string; html: string; text: string; tag: string }[] = [];
    const mailer: Mailer = {
      sendMail: vi.fn(async (input) => {
        sent.push(input);
        return { ok: true as const, messageId: "m-1" };
      }),
    };
    const token = "deep-link-token-1";
    const config = { ...testConfig(), publicAppUrl: "https://app.example.test" };
    const result = await sendMagicLinkEmail(mailer, config, "user@example.com", token);
    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    const [mail] = sent;
    const deepLink = magicLinkUrl(token);
    const click = `https://app.example.test/auth/open?token=${token}`;
    expect(mail.to).toBe("user@example.com");
    expect(mail.subject).toBe("Sign in to NomadVNC");
    expect(mail.tag).toBe("magic-link");
    expect(mail.html).toContain(`href="${click}"`);
    expect(mail.html).not.toContain(`href="${deepLink}"`);
    expect(mail.html).toContain(deepLink);
    expect(mail.text).toContain(click);
    expect(mail.text).toContain(deepLink);
  });

  it("falls back to the deep link when the server has no public address", async () => {
    const sent: { html: string }[] = [];
    const mailer: Mailer = {
      sendMail: vi.fn(async (input) => {
        sent.push(input);
        return { ok: true as const };
      }),
    };
    await sendMagicLinkEmail(mailer, testConfig(), "user@example.com", "tok");
    expect(sent[0]?.html).toContain(`href="${magicLinkUrl("tok")}"`);
  });
});

describe("sendShareInviteEmail", () => {
  it("escapes the user-chosen device label and owner in the HTML body", async () => {
    const sent: Array<{ subject: string; html: string; text: string }> = [];
    const mailer: Mailer = {
      sendMail: vi.fn(async (input) => {
        sent.push(input);
        return { ok: true as const };
      }),
    };
    await sendShareInviteEmail(mailer, testConfig(), "bob@example.com", {
      deviceLabel: '<a href="https://evil.example">Click to sign in</a>',
      ownerEmail: "alice@example.com\r\nBcc: victim@example.com",
    });
    const [mail] = sent;
    expect(mail.html).not.toContain("<a href");
    expect(mail.html).toContain("&lt;a href=&quot;https://evil.example&quot;&gt;");
    expect(mail.subject).not.toMatch(/[\r\n]/);
  });

  it("escapes every HTML metacharacter", () => {
    expect(escapeHtml(`<b>"Tom" & 'Jerry'</b>`)).toBe("&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;");
  });
});

describe("mail transports", () => {
  it("picks smtp, then postal, then none — and honors an explicit MAIL_TRANSPORT", () => {
    expect(resolveMailTransport({ SMTP_HOST: "mail.example.com", POSTAL_API_KEY: "k" })).toBe("smtp");
    expect(resolveMailTransport({ POSTAL_API_KEY: "k" })).toBe("postal");
    expect(resolveMailTransport({})).toBe("none");
    expect(resolveMailTransport({ MAIL_TRANSPORT: "log", SMTP_HOST: "mail.example.com" })).toBe("log");
    expect(() => resolveMailTransport({ MAIL_TRANSPORT: "carrier-pigeon" })).toThrow(/MAIL_TRANSPORT/);
  });

  it("loads SMTP settings with sensible port defaults", () => {
    const base = { DATABASE_URL: "postgres://x", JWT_SECRET: "s" };
    expect(loadConfig({ ...base, SMTP_HOST: "mail.example.com", SMTP_USER: "u", SMTP_PASS: "p" }).smtp).toEqual({
      host: "mail.example.com",
      port: 587,
      secure: false,
      user: "u",
      pass: "p",
    });
    expect(loadConfig({ ...base, SMTP_HOST: "mail.example.com", SMTP_SECURE: "true" }).smtp?.port).toBe(465);
    expect(loadConfig(base).postalApiUrl).toBe("");
  });

  it("sends through an SMTP transport with the configured sender", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const config = {
      ...testConfig(),
      mailReplyTo: "help@example.com",
      smtp: { host: "mail.example.com", port: 587, secure: false, user: "u", pass: "p" },
    };
    const mailer = createSmtpMailer(config, () => ({
      sendMail: async (message) => {
        sent.push(message);
        return { messageId: "<1@example.com>" };
      },
    }));
    const result = await sendMagicLinkEmail(mailer, config, "user@example.com", "tok");
    expect(result).toEqual({ ok: true, messageId: "<1@example.com>" });
    expect(sent[0]).toMatchObject({
      from: config.mailFrom,
      to: "user@example.com",
      replyTo: "help@example.com",
      subject: "Sign in to NomadVNC",
    });
  });

  it("reports SMTP failures instead of throwing", async () => {
    const config = { ...testConfig(), smtp: { host: "h", port: 587, secure: false, user: "", pass: "" } };
    const mailer = createSmtpMailer(config, () => ({
      sendMail: async () => {
        throw new Error("535 authentication failed");
      },
    }));
    await expect(sendMagicLinkEmail(mailer, config, "user@example.com", "tok")).resolves.toEqual({
      ok: false,
      error: "535 authentication failed",
    });
  });

  it("log transport prints the sign-in link; none refuses", async () => {
    const lines: string[] = [];
    const config = testConfig();
    await sendMagicLinkEmail(createLogMailer((line) => lines.push(line)), config, "user@example.com", "tok");
    expect(lines.join("\n")).toContain(magicLinkUrl("tok"));

    const result = await sendMagicLinkEmail(createMailer({ ...config, mailTransport: "none" }), config, "u@x.y", "t");
    expect(result.ok).toBe(false);
  });

  it("postal refuses without a server URL", async () => {
    const config = { ...testConfig(), postalApiUrl: "" };
    const result = await sendMagicLinkEmail(createMailer({ ...config, mailTransport: "postal" }), config, "u@x.y", "t");
    expect(result).toMatchObject({ ok: false });
  });
});
