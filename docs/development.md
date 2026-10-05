# Development

## Toolchain

| Tool | Version | For |
|---|---|---|
| Node.js | 22 (see `.nvmrc`) | everything JS |
| pnpm | 10 (`corepack enable`) | the workspace — don't use `npm install` |
| Go | per `go-core/go.mod` | the engine |
| Docker or Podman | any | only for the account server |
| JDK 17, Android SDK + NDK | see [NATIVE_SETUP](../apps/mobile/NATIVE_SETUP.md) | Android |
| Xcode 16 + CocoaPods | | iOS |

## First build

```bash
pnpm install       # JS dependencies for every package
pnpm build         # renderer, Electron main/preload, backend, Go sidecar
pnpm test          # all JS test suites + Go tests
```

## Everyday commands

| Task | Command |
|---|---|
| Desktop app with hot reload | `pnpm desktop:dev` |
| Desktop app, built | `pnpm desktop` |
| Typecheck everything | `pnpm turbo run typecheck` |
| JS tests | `pnpm turbo run test` |
| Go tests | `pnpm go:test` (`go test -race ./...` in `go-core/` for engine work) |
| One package | `pnpm --filter @nomadvnc/<desktop\|mobile\|backend\|viewer-shell> test` |
| Account server + mail catcher | `docker compose -f backend/compose.yaml up --build` |
| Mobile (Metro) | `pnpm mobile` — native builds: [NATIVE_SETUP](../apps/mobile/NATIVE_SETUP.md) |
| Linux packages | `pnpm desktop:package:linux` |
| Windows host exe | `pnpm build:host` |

`pnpm desktop:dev` hot-reloads the renderer. Changes to Electron's
`main/` or `preload/` need a restart, and changes to `go-core/` need
`pnpm build:go`.

## Repository layout

See [architecture.md](architecture.md). The short version:

- `apps/desktop/src/main` — Electron main process (privileged),
  `src/preload` — the bridge, `src/renderer` — the React UI.
- `apps/mobile/src` — React Native UI; native modules under `ios/` and
  `android/`.
- `go-core` — the engine; `backend` — the account server;
  `packages/*` — code shared by the apps.

## Conventions

- **TypeScript:** strict, plus `noUnusedLocals`. Each package has its own
  `tsconfig.json`; shared packages are consumed from source
  (`@nomadvnc/*` path aliases). `backend/` has a standalone tsconfig so it
  can be built in its own Docker context.
- **Local-first:** everything must keep working with no account and no
  Tailscale sign-in. Nothing may start a Tailscale login implicitly.
- **Secrets:** VNC passwords and tokens go to OS secure storage only —
  never into machine records, logs, or plain files.
- **Electron security:** keep the renderer sandboxed. Anything privileged
  (files, clipboard, network to the account server) is an IPC handler in
  the main process with validated input.
- **Viewer changes:** edit the protocol types in `packages/viewer-shell`
  first. After changing `bootstrap.mjs` or `input.mjs` (touch gestures,
  typing), run `pnpm --filter @nomadvnc/mobile sync-viewer-assets` and
  commit the copied files. Gesture changes also update the in-app list
  (`apps/mobile/src/components/GestureGuide.tsx`) and
  [the user guide](guides/using-nomadvnc.md).
- **Theming:** follow the OS light/dark setting; check both.
- **Branding:** edit `branding/logo.svg` (and its copy in
  `apps/desktop/src/renderer/public/`), then run `pnpm icons` — it renders
  the desktop, Android (including adaptive and themed), and iOS icons.
  Commit the regenerated mobile icons.
- **Formatting:** `.editorconfig` (2 spaces, LF). There is no linter yet.

## Testing against a real VNC server

Any VNC server works. A quick throwaway one on Linux:

```bash
echo "secret12" | vncpasswd -f > /tmp/passwd
Xvnc :55 -rfbport 5955 -rfbauth /tmp/passwd -localhost -geometry 1600x900 &
```

Then connect to `127.0.0.1`, port `5955`. (From the Android emulator the
host is `10.0.2.2`.)

## Troubleshooting

- **`electron` exits immediately / runs as Node:** your shell exports
  `ELECTRON_RUN_AS_NODE` (some editors set it). Unset it.
- **Icon generation fails in CI or over SSH:** it drives a hidden Electron
  window and needs a display — use `xvfb-run` or `DISPLAY=:0`.
- **"Save Password Securely" disabled on Linux:** see
  [install.md](guides/install.md#saving-passwords-on-linux).
- **Metro crashes after `pnpm install`:** it watches the pnpm store;
  restart it.
- **Windows PowerShell blocks `pnpm`:** use `pnpm.cmd` or allow the shim's
  execution policy.
