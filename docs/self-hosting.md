# Self-hosting the account server

NomadVNC works fully without an account. An account adds three things:
your saved machines sync between your devices, saved VNC passwords roam
with them, and you can share a machine with someone by email.

Accounts live on a small server: Node.js + PostgreSQL in one Docker
image, in [`backend/`](../backend/). You can run your own, or use the
public endpoint.

## Option 1 — the public endpoint

The apps point at `https://api.nomadvnc.dev.greg.tech` by default. I run
that server for anyone to use, **best-effort, with no uptime or support
guarantee**. It stores what the account features need:

- your email address,
- your saved machines' names, addresses, ports and groups,
- saved VNC passwords and shared tailnet keys — encrypted at rest, but
  decryptable by the server (this is not end-to-end encryption),
- who you've shared machines with.

If that's not acceptable for your use, run your own server — it's the
same code.

## Option 2 — run your own

### Try it locally (two minutes)

```bash
git clone https://github.com/grpace/NomadVNC.git && cd NomadVNC
DATA_KEY=$(openssl rand -hex 32) docker compose -f backend/compose.yaml up --build
```

This starts PostgreSQL, the server on `http://localhost:3200`, and
[Mailpit](https://mailpit.axllent.org/), a mail catcher: sign-in emails
show up at <http://localhost:8025> instead of being delivered. In the
desktop app open **Account → Advanced Server Settings**, enter
`http://localhost:3200`, then sign in with any address and open the link
from Mailpit.

### Production

You need:

- a machine that runs Docker (or Node.js 22),
- PostgreSQL 14 or newer (16 is what's tested),
- a public HTTPS address for the server, e.g. `https://nomad.example.com`
  (session tokens and saved passwords travel over it — never use plain
  HTTP beyond `localhost`),
- a way to send email (below).

Build the image from the repo:

```bash
docker build -t nomadvnc-backend backend/
```

A minimal stack with automatic HTTPS via [Caddy](https://caddyserver.com):

```yaml
# compose.yaml
services:
  db:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: nomad
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: nomadvnc
    volumes: [pgdata:/var/lib/postgresql/data]

  backend:
    image: nomadvnc-backend
    restart: unless-stopped
    env_file: .env          # see the variables below
    environment:
      DATABASE_URL: postgres://nomad:${POSTGRES_PASSWORD}@db:5432/nomadvnc
      TRUST_PROXY: "1"
    depends_on: [db]

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    command: caddy reverse-proxy --from nomad.example.com --to backend:3200
    volumes: [caddy:/data]

volumes:
  pgdata:
  caddy:
```

Database migrations (and data-key rotation) run automatically every time
the container starts. Running without Docker: `pnpm --filter
@nomadvnc/backend build`, then `node dist/migrate-run.js && node
dist/index.js` from `backend/`.
Check it's up with `curl https://nomad.example.com/health` → `{"ok":true}`.

### Configuration

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string. |
| `JWT_SECRET` | yes | Signs session tokens. 32+ random bytes: `openssl rand -hex 32`. |
| `DATA_KEY` | for sync & sharing | 32-byte key (`openssl rand -hex 32`) that encrypts saved passwords and shared tailnet keys. Without it those endpoints return 503. **Back it up** — see below. |
| `DATA_KEY_OLD` | rotation only | The previous key while rotating. |
| `TRUST_PROXY` | behind a proxy | `1` when one reverse proxy (Caddy, nginx, Traefik) sits in front. Without it every user shares the proxy's IP for rate limiting. Leave empty if the port is exposed directly. |
| `PUBLIC_APP_URL` | recommended | The server's public address, e.g. `https://nomad.example.com`. Used in sign-in and account-deletion emails; if empty, it's taken from each request. |
| `PORT` | no | Listen port (default `3200`). |
| `JWT_EXPIRES_IN` | no | Session lifetime (default `365d`). The apps trade a token for a fresh one at launch, on return to the foreground, and hourly on desktop once it is 12 hours old or halfway to expiry. A session ends only after this long without opening the app, or at sign-out. |
| `MAGIC_LINK_TTL_MINUTES` | no | Sign-in link lifetime (default `15`). |
| `MAIL_*`, `SMTP_*`, `POSTAL_*` | for email | See [Email](#email). |

`backend/.env.example` lists them all with comments.

### Point the apps at your server

- **Desktop:** Account → **Advanced Server Settings** → your URL.
- **Mobile:** **Sign in** → *Server: … **Change*** → your URL.

Sign-in emails contain an https button (`/auth/open`) because webmail
will not make a `nomadvnc://` link clickable. That page opens the app.
Desktop and the phone apps register `nomadvnc://` and sign in when that
link opens them, including if the app is already running. The email also
includes the `nomadvnc://` address to paste into the sign-in box. Set `PUBLIC_APP_URL` to the address people can reach, or the
button points at whatever host handled the request. The other web pages
are the account-deletion confirm pages below.

### Account deletion

Users can delete their account from either app (Account → Delete
account). For people without the app — app stores require this — the
server also has a web flow: a form that `POST`s `email` to
`/api/v1/account/deletion-request` (form-encoded or JSON) emails a
single-use link to `/api/v1/account/delete`, which shows a confirm
button. Host that form on any web page; no CORS setup is needed.
Deletion removes the user, their synced machines and passwords, shares
they created, and shares made to their email.

If you run a server for other people, publish your own privacy policy —
[PRIVACY.md](../PRIVACY.md) covers the public server only.

## Email

The server sends two kinds of email: sign-in links and share invites.
Pick one transport. If both SMTP and Postal are configured, SMTP wins;
`MAIL_TRANSPORT` forces a choice.

### SMTP — your own mail server or any provider

Works with anything that speaks SMTP: a mail server you run (Postfix,
Mailcow, Mailu, Stalwart, Maddy, …) or a provider (Fastmail, Migadu,
Amazon SES, Mailgun, Postmark, Brevo, Gmail with an app password, …).

```bash
SMTP_HOST=smtp.example.com
SMTP_PORT=587            # 587 = STARTTLS (default); 465 = implicit TLS
SMTP_SECURE=false        # true for port 465
SMTP_USER=signin@example.com
SMTP_PASS=…
MAIL_FROM="NomadVNC <signin@example.com>"
MAIL_REPLY_TO=           # optional
```

If you run your own mail server, sign-in emails only arrive reliably
when the sending domain is set up properly:

- **SPF** — a TXT record on the `MAIL_FROM` domain allowing your server
  (e.g. `v=spf1 mx -all`).
- **DKIM** — sign outgoing mail; publish the public key in DNS.
- **DMARC** — e.g. `v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com`.
- **Reverse DNS** for the server's IP matching its hostname.
- Many home ISPs and cloud providers block outbound port 25; relaying
  through a provider (port 587) avoids that.

### Postal — self-hosted mail platform

[Postal](https://docs.postalserver.io/) is a full mail delivery platform
you can run yourself. Create a mail server and an API credential in
Postal, then:

```bash
POSTAL_API_URL=https://postal.example.com
POSTAL_API_KEY=…
MAIL_FROM="NomadVNC <signin@example.com>"
```

The same SPF/DKIM/DMARC advice applies; Postal shows the exact DNS
records to add.

### Log — no mail server at all

```bash
MAIL_TRANSPORT=log
```

Instead of sending, the server prints each email — including the sign-in
link — to its log (`docker compose logs backend`). Copy the link into
the app's **Paste sign-in link** box. Fine for a server only you use;
**anyone who can read the logs can sign in as anyone**, so don't use it
for a shared server.

With no transport configured, the server starts but can't send sign-in
emails, and says so in its log.

## The data key

`DATA_KEY` encrypts every saved password and shared tailnet key
(AES-256-GCM; each value is bound to its device and owner so it can't be
moved between records). The key is only ever read from the environment —
it is never written to the database.

- **Back it up somewhere other than the database backup.** If you lose
  it, stored passwords can't be decrypted; users re-enter them.
- **Rotate** by setting `DATA_KEY_OLD` to the current key and `DATA_KEY`
  to a new one, then restarting: rows are re-encrypted under the new key
  at startup. Remove `DATA_KEY_OLD` afterwards.

## Backups and upgrades

- Back up PostgreSQL as usual (`pg_dump`) and keep `DATA_KEY` and
  `JWT_SECRET` in your secrets store.
- To upgrade: pull the repo, rebuild the image, restart. Migrations are
  applied automatically and are idempotent.
- Upgrading a server that ran a release before 1.0.0: schema v4 removes a
  column that used to hold key material. After the first start, run
  `VACUUM FULL data_keys;` in `psql` to scrub it from disk, and rotate
  `DATA_KEY` if old database dumps exist.
- Also before 1.0.0: `POSTAL_API_URL` used to have a built-in default.
  It no longer does — if you send through Postal, set it explicitly, or
  sign-in emails stop going out (the log says why). Behind a reverse
  proxy, add `TRUST_PROXY=1` so rate limiting sees real client IPs.

## Security checklist

- Serve the API over HTTPS only.
- Keep PostgreSQL off the public internet.
- Use long random values for `JWT_SECRET`, `DATA_KEY`, and the database
  password.
- Set `TRUST_PROXY` to match your setup — too permissive lets clients
  spoof their IP past the rate limiter.
- Leave `CORS_ORIGIN` empty: the apps call the API from native code, not
  from a browser page.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| App says "Sign-in link sent" but nothing arrives | Check the server log for `magic-link mail failed`; then SPF/DKIM, spam folder, provider sending limits. The app always reports success so it can't be used to probe which addresses have accounts. |
| "Account server unreachable" | Wrong URL, no HTTPS, or a firewall. `curl https://your-server/health` should return `{"ok":true}`. |
| Saving a password or sharing returns 503 | `DATA_KEY` isn't set. |
| "Too many requests" for everyone | Behind a proxy without `TRUST_PROXY=1`. |

For how the API works, see [architecture.md](architecture.md#account-server).
