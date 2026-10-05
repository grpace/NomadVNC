import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendConfig } from "../src/config.js";
import type { DbClient } from "../src/db.js";
import { signToken } from "../src/jwt.js";
import type { Mailer } from "../src/mailer.js";
import { createApp } from "../src/server.js";
import { generateOpaqueToken, hashOpaqueToken } from "../src/tokens.js";

interface UserRow {
  id: string;
  email: string;
  credential_version: number;
}

interface LinkRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  consumed_at: string | null;
  /** Unset = "signin" (the column default). */
  purpose?: string;
}

/** In-memory stand-in for Postgres covering exactly the queries auth uses. */
class FakeDb implements DbClient {
  users: UserRow[] = [];
  links: LinkRow[] = [];
  shares: Array<{ grantee_email: string; created_by: string }> = [];
  private counter = 1;

  async query<T>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const sql = text.replace(/\s+/g, " ").trim();
    if (sql.startsWith("SELECT id, email, credential_version FROM users WHERE email")) {
      return { rows: this.users.filter((u) => u.email === params[0]) as T[] };
    }
    if (sql.startsWith("INSERT INTO users")) {
      const email = params[0] as string;
      let user = this.users.find((u) => u.email === email);
      if (!user) {
        user = { id: `user-${this.counter++}`, email, credential_version: 1 };
        this.users.push(user);
      }
      return { rows: [user] as T[] };
    }
    if (sql.startsWith("INSERT INTO magic_links")) {
      this.links.push({
        id: `link-${this.counter++}`,
        user_id: params[0] as string,
        token_hash: params[1] as string,
        expires_at: params[2] as string,
        consumed_at: null,
        purpose: params[3] as string,
      });
      return { rows: [] as T[] };
    }
    if (sql.startsWith("UPDATE magic_links SET consumed_at = now() WHERE token_hash")) {
      const link = this.links.find(
        (l) =>
          l.token_hash === params[0] &&
          (l.purpose ?? "signin") === params[1] &&
          l.consumed_at === null &&
          new Date(l.expires_at).getTime() > Date.now(),
      );
      if (!link) {
        return { rows: [] as T[] };
      }
      link.consumed_at = new Date().toISOString();
      return { rows: [{ user_id: link.user_id }] as T[] };
    }
    if (sql.startsWith("SELECT id, email, credential_version FROM users WHERE id")) {
      return { rows: this.users.filter((u) => u.id === params[0]) as T[] };
    }
    if (sql.startsWith("SELECT credential_version FROM users WHERE id")) {
      return {
        rows: this.users
          .filter((u) => u.id === params[0])
          .map((u) => ({ credential_version: u.credential_version })) as T[],
      };
    }
    if (sql.startsWith("SELECT id FROM users WHERE email")) {
      return { rows: this.users.filter((u) => u.email === params[0]).map((u) => ({ id: u.id })) as T[] };
    }
    if (sql.startsWith("DELETE FROM shares WHERE grantee_email")) {
      const user = this.users.find((u) => u.id === params[0]);
      this.shares = this.shares.filter((share) => share.grantee_email !== user?.email);
      return { rows: [] as T[] };
    }
    if (sql.startsWith("DELETE FROM users WHERE id")) {
      const user = this.users.find((u) => u.id === params[0]);
      if (!user) {
        return { rows: [] as T[] };
      }
      // ON DELETE CASCADE: links, devices (+ credentials), shares they created.
      this.users = this.users.filter((u) => u !== user);
      this.links = this.links.filter((l) => l.user_id !== user.id);
      this.shares = this.shares.filter((share) => share.created_by !== user.id);
      return { rows: [{ id: user.id }] as T[] };
    }
    if (sql.startsWith("UPDATE users SET credential_version")) {
      const user = this.users.find((u) => u.id === params[0]);
      if (user) {
        user.credential_version += 1;
      }
      return { rows: [] as T[] };
    }
    throw new Error(`FakeDb: unexpected query: ${sql}`);
  }
}

class FakeMailer implements Mailer {
  sent: Array<{ to: string; subject: string; tag: string }> = [];
  async sendMail(input: { to: string; subject: string; html: string; text: string; tag: string }) {
    this.sent.push({ to: input.to, subject: input.subject, tag: input.tag });
    return { ok: true as const, messageId: "test-id" };
  }
}

const config: BackendConfig = {
  port: 3200,
  databaseUrl: "postgres://fake",
  jwtSecret: "test-secret-at-least-32-bytes-long!",
  jwtExpiresIn: "24h",
  publicAppUrl: "https://app.example.test",
  corsOrigin: "",
  postalApiUrl: "https://postal.example.test",
  postalApiKey: "test-key",
  mailFrom: "NomadVNC <test@example.test>",
  mailReplyTo: "",
  magicLinkTtlMinutes: 15,
  dataKeys: [],
};

describe("backend auth", () => {
  let db: FakeDb;
  let mailer: FakeMailer;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = new FakeDb();
    mailer = new FakeMailer();
    app = createApp({ config, db, mailer });
  });

  afterEach(() => {
    // Rate limiter state lives per app instance; fresh instance per test.
  });

  it("serves a page that opens the app and does not consume the token", async () => {
    const token = generateOpaqueToken();
    const res = await request(app).get("/auth/open").query({ token });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.text).toContain(`nomadvnc://auth/callback?token=${token}`);
    expect(res.text).toContain("Open NomadVNC");
    expect(res.text).not.toContain('http-equiv="refresh"');
    expect(db.links).toHaveLength(0);
  });

  it("rejects a sign-in page token that is not a real token", async () => {
    const res = await request(app).get("/auth/open").query({ token: "<script>alert(1)</script>" });
    expect(res.status).toBe(400);
    expect(res.text).not.toContain("<script>alert");
    expect(res.text).toContain("not valid");
  });

  it("reports health", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("requests a magic link with a generic response and sends mail", async () => {
    const res = await request(app).post("/api/v1/auth/magic-link").send({ email: "Alice@Example.test" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(db.users).toHaveLength(1);
    expect(db.users[0]?.email).toBe("alice@example.test");
    expect(db.links).toHaveLength(1);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]?.tag).toBe("magic-link");
  });

  it("stays generic for invalid emails and honeypots", async () => {
    for (const body of [{ email: "not-an-email" }, { email: "x@y.z", website: "spam" }, {}]) {
      const res = await request(app).post("/api/v1/auth/magic-link").send(body);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    }
    expect(db.users).toHaveLength(0);
    expect(mailer.sent).toHaveLength(0);
  });

  it("consumes a link once and rejects reuse, expiry, and garbage", async () => {
    await request(app).post("/api/v1/auth/magic-link").send({ email: "bob@example.test" });
    const link = db.links[0];
    if (!link) {
      throw new Error("expected a stored link");
    }
    // Recover a valid token: only its hash is stored, so mint a sibling.
    const raw = generateOpaqueToken();
    db.links.push({
      id: "link-sibling",
      user_id: link.user_id,
      token_hash: hashOpaqueToken(raw),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      consumed_at: null,
    });

    const first = await request(app).post("/api/v1/auth/consume").send({ token: raw });
    expect(first.status).toBe(200);
    expect(typeof first.body.token).toBe("string");

    const reuse = await request(app).post("/api/v1/auth/consume").send({ token: raw });
    expect(reuse.status).toBe(401);

    const garbage = await request(app).post("/api/v1/auth/consume").send({ token: "nope" });
    expect(garbage.status).toBe(401);

    db.links.push({
      id: "link-expired",
      user_id: link.user_id,
      token_hash: hashOpaqueToken("expired-token"),
      expires_at: new Date(Date.now() - 60_000).toISOString(),
      consumed_at: null,
    });
    const expired = await request(app).post("/api/v1/auth/consume").send({ token: "expired-token" });
    expect(expired.status).toBe(401);
  });

  it("logs out by bumping the credential version", async () => {
    await request(app).post("/api/v1/auth/magic-link").send({ email: "carol@example.test" });
    const user = db.users[0];
    if (!user) {
      throw new Error("expected a user");
    }
    const token = signToken(config, user);

    const authed = await request(app)
      .post("/api/v1/auth/logout")
      .set("Authorization", `Bearer ${token}`);
    expect(authed.status).toBe(200);

    // Old token is now dead.
    const retry = await request(app)
      .post("/api/v1/auth/logout")
      .set("Authorization", `Bearer ${token}`);
    expect(retry.status).toBe(401);

    const anon = await request(app).post("/api/v1/auth/logout");
    expect(anon.status).toBe(401);
  });

  it("redeems a link exactly once even when consumes race", async () => {
    await request(app).post("/api/v1/auth/magic-link").send({ email: "dave@example.test" });
    const raw = generateOpaqueToken();
    db.links.push({
      id: "link-race",
      user_id: db.users[0]?.id ?? "",
      token_hash: hashOpaqueToken(raw),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      consumed_at: null,
    });
    const results = await Promise.all([
      request(app).post("/api/v1/auth/consume").send({ token: raw }),
      request(app).post("/api/v1/auth/consume").send({ token: raw }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it("answers a JSON 500 instead of crashing when the database throws", async () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken: DbClient = {
      query: async () => {
        throw new Error("connection refused");
      },
    };
    const brokenApp = createApp({ config, db: broken, mailer });
    const res = await request(brokenApp).post("/api/v1/auth/consume").send({ token: "anything" });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    quiet.mockRestore();
  });

  it("rejects malformed JSON bodies with a JSON 400", async () => {
    const res = await request(app)
      .post("/api/v1/auth/consume")
      .set("Content-Type", "application/json")
      .send("{not json");
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "Malformed JSON body" });
  });
});

describe("account deletion", () => {
  let db: FakeDb;
  let mailer: FakeMailer;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = new FakeDb();
    mailer = new FakeMailer();
    app = createApp({ config, db, mailer });
  });

  async function signUp(email: string): Promise<{ user: UserRow; jwt: string }> {
    await request(app).post("/api/v1/auth/magic-link").send({ email });
    const user = db.users.find((u) => u.email === email);
    if (!user) {
      throw new Error("expected a user");
    }
    return { user, jwt: signToken(config, user) };
  }

  it("deletes the signed-in account and everything tied to it", async () => {
    const { user, jwt } = await signUp("erin@example.test");
    const other = await signUp("frank@example.test");
    db.shares.push(
      { grantee_email: "frank@example.test", created_by: user.id },
      { grantee_email: "erin@example.test", created_by: other.user.id },
      { grantee_email: "grace@example.test", created_by: other.user.id },
    );

    const res = await request(app).delete("/api/v1/account").set("Authorization", `Bearer ${jwt}`);
    expect(res.status).toBe(200);
    expect(db.users.map((u) => u.email)).toEqual(["frank@example.test"]);
    expect(db.links.every((l) => l.user_id !== user.id)).toBe(true);
    // Their own shares and shares made to them are gone; others' stay.
    expect(db.shares).toEqual([{ grantee_email: "grace@example.test", created_by: other.user.id }]);

    // The old session can't be used afterwards.
    const again = await request(app).delete("/api/v1/account").set("Authorization", `Bearer ${jwt}`);
    expect(again.status).toBe(401);
  });

  it("requires sign-in for in-app deletion", async () => {
    const res = await request(app).delete("/api/v1/account");
    expect(res.status).toBe(401);
  });

  it("emails a deletion link from the web form without revealing or creating accounts", async () => {
    await signUp("hana@example.test");
    mailer.sent = [];

    const known = await request(app)
      .post("/api/v1/account/deletion-request")
      .type("form")
      .send({ email: "hana@example.test" });
    expect(known.status).toBe(200);
    expect(known.headers["content-type"]).toMatch(/text\/html/);
    expect(known.text).toContain("Check your email");
    expect(mailer.sent).toEqual([
      expect.objectContaining({ to: "hana@example.test", tag: "account-deletion" }),
    ]);
    expect(db.links.at(-1)?.purpose).toBe("delete");

    const unknown = await request(app)
      .post("/api/v1/account/deletion-request")
      .type("form")
      .send({ email: "nobody@example.test" });
    expect(unknown.text).toBe(known.text);
    expect(db.users.some((u) => u.email === "nobody@example.test")).toBe(false);
    expect(mailer.sent).toHaveLength(1);
  });

  it("confirms on POST only, once, and never accepts sign-in links", async () => {
    const { user } = await signUp("ivan@example.test");
    const deletion = generateOpaqueToken();
    db.links.push({
      id: "link-delete",
      user_id: user.id,
      token_hash: hashOpaqueToken(deletion),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      consumed_at: null,
      purpose: "delete",
    });

    // GET shows a confirm page and deletes nothing (mail scanners open links).
    const view = await request(app).get(`/api/v1/account/delete?token=${deletion}`);
    expect(view.status).toBe(200);
    expect(view.headers["x-robots-tag"]).toBe("noindex");
    expect(view.text).toContain('name="token"');
    expect(db.users).toHaveLength(1);

    // A deletion link can't sign anyone in.
    const asSignIn = await request(app).post("/api/v1/auth/consume").send({ token: deletion });
    expect(asSignIn.status).toBe(401);

    // A sign-in link can't delete the account.
    const signIn = generateOpaqueToken();
    db.links.push({
      id: "link-signin",
      user_id: user.id,
      token_hash: hashOpaqueToken(signIn),
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      consumed_at: null,
    });
    const wrongKind = await request(app).post("/api/v1/account/delete").type("form").send({ token: signIn });
    expect(wrongKind.status).toBe(400);
    expect(db.users).toHaveLength(1);

    const confirm = await request(app).post("/api/v1/account/delete").type("form").send({ token: deletion });
    expect(confirm.status).toBe(200);
    expect(confirm.text).toContain("Account Deleted");
    expect(db.users).toHaveLength(0);

    const reuse = await request(app).post("/api/v1/account/delete").type("form").send({ token: deletion });
    expect(reuse.status).toBe(400);
  });
});
