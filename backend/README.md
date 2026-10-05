# NomadVNC account server

Optional server behind Nomad accounts: passwordless email sign-in, synced
machines and encrypted passwords, and per-machine sharing. Express +
PostgreSQL, shipped as one Docker image.

- **Run your own:** [docs/self-hosting.md](../docs/self-hosting.md)
  (configuration, email via SMTP/Postal/log, data key, backups).
- **How it works:** [docs/architecture.md](../docs/architecture.md#account-server)
  (API, data model, encryption).

## Development

```bash
docker compose -f backend/compose.yaml up --build   # Postgres + server + Mailpit
# server:  http://localhost:3200/health
# emails:  http://localhost:8025
```

From the repo root:

```bash
pnpm --filter @nomadvnc/backend test        # vitest, fake database and mailer
pnpm --filter @nomadvnc/backend typecheck
pnpm --filter @nomadvnc/backend build       # tsc → dist/
```

Layout: `src/routes/` (auth, devices, shares), `src/crypto.ts`
(AES-256-GCM envelopes), `src/mailer.ts` (SMTP / Postal / log),
`src/http.ts` (async error handling), `src/schema*.sql` (migrations,
applied in order by `src/migrate.ts`).

Notes for contributors:

- Every async route goes through `asyncRoute`: Express 4 doesn't catch
  rejected promises, and an unhandled rejection would stop the process.
- This package's `tsconfig.json` deliberately doesn't extend the repo's
  base config, because the Docker build only sees `backend/`.
- The Docker build runs `npm install` without a lockfile (the pnpm
  lockfile lives outside `backend/`), so dependency versions float within
  their `^` ranges.
