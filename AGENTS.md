# NomadVNC — Guide for AI coding agents

Instructions for AI coding agents working in this repo; read before making
changes. Human contributors: start with `CONTRIBUTING.md` and
`docs/development.md` — everything here is consistent with them.

Public docs: `README.md`, `docs/architecture.md`, `docs/development.md`,
`docs/self-hosting.md`, `docs/releasing.md`, `docs/guides/`. The
maintainer may keep private working notes in `docs/internal/` (gitignored;
handoffs, planning). If it exists locally, read
`docs/internal/handoff-current.md` first and append to it at stopping
points — never commit anything under `docs/internal/`.

## 1. Stack & Layout

- `apps/desktop` — Electron + React 19 + Vite (macOS/Windows/Linux). Usable
  end-to-end today with optional Tailscale login (tailnet discovery) +
  optional Nomad account (cloud sync). Local mode works with neither.
  Entry: `pnpm desktop:dev`.
- `apps/mobile` — React Native 0.79 + WebView viewer. JS shell is complete
  (typed `NomadNativeModule` bridge, local-first manual connect, viewer
  assets pipeline, 131 tests); GoMobile bindings in `go-core/mobile` and
  Swift/Kotlin native modules (`ios/NomadVNC/NomadNativeModule.*`,
  `android/.../com/nomadvnc/`). The native projects are committed; Android
  builds and runs on an emulator from Linux (recipe: `apps/mobile/
  NATIVE_SETUP.md` §5a — needs JDK 17). The iOS app compiles and launches
  in the simulator. Installing it on a physical iPhone is still open.
- `packages/domain` — shared product types (machines, peers, sessions).
- `packages/platform-contracts` — `NomadNativePlatform` bridge contract
  (desktop) and `NomadMobilePlatform` (mobile: shared subset + viewer asset
  URL). Desktop implements its contract fully; mobile's native modules
  implement the mobile one.
- `packages/viewer-shell` — typed noVNC postMessage protocol
  (`ViewerCommand` / `ViewerEvent`).
- `go-core` — Go sidecar (`tsnet` node + localhost WebSocket→TCP VNC proxy).
  Module `github.com/nomadvnc/nomadvnc/go-core`, Go 1.27.
- `backend` — self-hosted account service (Express + Postgres: magic-link
  auth, device/credential sync, sharing). Own `tsconfig.json` (NOT
  extending `tsconfig.base.json` — the Docker build context is `backend/`
  and can't see the base file). Local stack (Postgres + server + Mailpit):
  `docker compose -f backend/compose.yaml up --build`. Mail: SMTP, Postal,
  or `MAIL_TRANSPORT=log` (`src/mailer.ts`).
- `branding/logo.svg` — single source of truth for logo/icons.
- `scripts/build-go.mjs` — builds the sidecar into `go-core/bin/`.

## 2. Toolchain (do not substitute)

- Node 22 (`cat .nvmrc`), `pnpm@10.7.0` — **never `npm install`**, this is a
  pnpm workspace. Go toolchain per `go-core/go.mod`.
- Bootstrap: `pnpm install` → `pnpm go:tidy` → `pnpm build` → `pnpm test`.
- JS deps via `pnpm`; Go deps via `go mod tidy` / `go build` / `go test`.

## 3. Commands (run from repo root unless noted)

| Task | Command |
|---|---|
| Install | `pnpm install` |
| Full build (turbo + sidecar) | `pnpm build` |
| All typechecks | `pnpm turbo run typecheck` (6 tasks, must be green) |
| All JS tests | `pnpm turbo run test` (desktop + viewer-shell + backend vitest) |
| Go tests | `pnpm go:test` (or `go test ./...` in `go-core`) |
| Backend dev (needs Docker) | `docker compose -f backend/compose.yaml up --build` |
| Everything | `pnpm test` (= turbo test + go tests) |
| Desktop dev (HMR) | `pnpm desktop:dev` |
| Desktop run built | `pnpm desktop` |
| Linux packaging | `pnpm desktop:package:linux` → `apps/desktop/release/` |
| Windows host exe | `pnpm build:host` → `go-core/bin/nomadvnc-host.exe` |
| Mobile dev (Metro) | `pnpm mobile` |
| Single-package check | `pnpm --filter @nomadvnc/<name> typecheck` (or `test`) |

## 4. TypeScript Rules

- `tsconfig.base.json` holds shared compiler options (`strict`, path aliases
  for all `@nomadvnc/*` packages). Every app/package has its own `tsconfig.json`
  extending it with a scoped `include` — **never run `tsc -p tsconfig.base.json`**
  (it drags in cross-app sources). Exception: `backend` carries a
  self-contained `tsconfig.json` (documented in `backend/README.md`)
  because its Docker image builds standalone.
- Keep `include` scoped to the package's `src/` (+ shared package sources where
  the app imports them, mirroring `apps/desktop/tsconfig.json`).
- `noUnusedLocals` is on everywhere (base + backend) — the only lint-like
  guard until a linter lands, so dead imports/locals fail typecheck.
- Path aliases (`@nomadvnc/domain` etc.) map to `packages/*/src/index.ts`;
  keep `main`/`exports` pointing at `./src/index.ts` (source-first, no build).

## 5. Go Rules (`go-core`)

- `go vet ./...` + `go test ./...` must pass. No `Makefile`; build via
  `pnpm build:go` (wraps `go build -o bin/ ./cmd/nomadvnc-sidecar`).
- `bin/` is gitignored build output — never commit binaries. Delete stray
  `*.exe~` backups; don't add new ones.
- Lint config is `.golangci.yml` (run `golangci-lint run ./...` when available).

## 6. Conventions

- Progressive onboarding & local-first is the rule: Step 1 asks the user to
  choose between a Nomad account (cloud sync) or Local mode (no account,
  device-only). Step 2 makes Tailscale sign-in optional for automatic remote
  discovery (with manual host/IP connect always available). Local-only use
  without an account stays fully functional and must not regress.
  `ownerMode: "guest"` represents "local, unsynced" mode.
- Saved machines key on stable tailnet identity (`tailscaleStableId`), not IPs.
  Exception: machines saved by typed address (local-first, no tailnet
  device) use `manual:<host>` (`manualStableId` / `isManualMachine` in
  `@nomadvnc/domain`); they always dial directly and show no tailnet
  presence. Legacy rows keyed by their own non-tailnet address count too.
- Connection errors stay honest: a rejected password (`viewerState:
  authFailed`) prompts for a new one and never auto-retries; a session that
  never completed a handshake reports "couldn't connect" without retries;
  only drops of a live session auto-reconnect.
- VNC secrets: OS secure storage only (Electron `safeStorage` on desktop);
  never log secrets, never put them in machine metadata records.
- Viewer protocol changes go through `packages/viewer-shell` types first, then
  `ViewerPanel.tsx` (desktop) and the mobile WebView host. After editing
  `bootstrap.mjs` or `input.mjs`, run `pnpm --filter @nomadvnc/mobile
  sync-viewer-assets` (the iOS/Android copies are committed). Zoom/pan
  goes through noVNC's display viewport (`applyView`), never CSS
  transforms — transforms break pointer coordinates. Touch gestures live
  in `input.mjs` (unit-tested); keep `GestureGuide.tsx` and
  `docs/guides/using-nomadvnc.md` in step with it.
- Electron security model: the window runs with `sandbox: true` and
  `contextIsolation`; the preload only uses `contextBridge` + `ipcRenderer`,
  so anything privileged (clipboard, account HTTP, secrets) is a
  main-process IPC handler. The renderer CSP allows only loopback
  `connect-src` — account-backend calls go through
  `window.nomadNative.accountRequest` (`main/accountHttp.ts`), never a
  renderer `fetch`. External links open only if http(s)
  (`main/navigation.ts`); the window can't navigate away from the app.
- Tailscale sign-in is never started implicitly: launch reads state
  passively (`getTailnetState`); only explicit CTAs call
  `ensureTailnetReady` (which can open the browser).
- Theming: follow OS light/dark via `prefers-color-scheme`; no dark-only design.
- Branding: edit `branding/logo.svg`, copy it to
  `apps/desktop/src/renderer/public/logo.svg`, then `pnpm icons` (renders
  desktop, Android, and iOS icons; commit the mobile ones).
- User-visible behaviour or setup changes → update the public docs (and
  `CHANGELOG.md` under Unreleased). Engineering state → the private
  handoff in `docs/internal/` when present.

## 7. Safety & Hygiene

- Never commit: `node_modules/`, `dist*/`, `build/`, `release/`, `coverage/`,
  `.turbo/`, `go-core/bin/`, `.env*`, IDE dirs, mobile `Pods/`/`build/`.
  (Enforced by `.gitignore` — check before `git add`.)
- Copy `backend/.env.example` to `backend/.env` for local secrets (never
  commit real values); production secrets live in the deployment's
  environment only.
- Verify before finishing: `pnpm turbo run typecheck` + relevant `test`.
  For desktop viewer/session work also run `pnpm --filter @nomadvnc/desktop test`
  and `pnpm --filter @nomadvnc/viewer-shell test`.
- No CI bypasses, no force-push, no committing secrets. Small focused commits;
  match the existing `feat:/refactor:` commit style.
- Known follow-ups (don't "fix" silently — ask or file): installing the
  iOS app on a physical iPhone. The simulator build compiles and launches.

## 8. What's Deliberately Missing

- No ESLint/Prettier configs yet — `.editorconfig` holds basic formatting
  (2-space, LF, trim trailing whitespace). Adding a linter is an open task.
  Dead-code checks that work today: `npx knip` (expect false positives for
  entry points and runtime-loaded vendor files), `deadcode`/`staticcheck`
  for Go.
- License: Apache-2.0 (root `LICENSE`, chosen 2026-09-09). Keep headers/notices
  intact on redistribution.
