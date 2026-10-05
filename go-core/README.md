# go-core — the NomadVNC engine

Go module `github.com/nomadvnc/nomadvnc/go-core` (Go version pinned in
`go.mod`). One engine, two viewer hosts, plus an optional Windows screen-sharing program:

- **Desktop:** `cmd/nomadvnc-sidecar`, a child process of the Electron app
  that speaks newline-delimited JSON over stdin/stdout.
- **Mobile:** `mobile/`, GoMobile bindings (`Mobile.xcframework` /
  `mobile.aar`) called from the React Native native modules.
- **Windows host:** `cmd/nomadvnc-host`, an optional companion that shares
  a PC's screen. Any VPN can reach it. Tailscale sign-in inside it is
  optional.

The engine embeds a Tailscale [`tsnet`](https://pkg.go.dev/tailscale.com/tsnet)
node — a private, per-install tailnet device used only for NomadVNC's own
traffic, not a system-wide VPN — and runs a loopback-only WebSocket→TCP
proxy per VNC session so the noVNC viewer can reach the VNC server.

## Layout

| Path | What |
|---|---|
| `cmd/nomadvnc-sidecar/` | Desktop sidecar binary: request loop + event stream. |
| `cmd/nomadvnc-host/` | Optional Windows companion that shares the PC's screen. Tailscale sign-in is optional; any VPN works. |
| `internal/engine/` | Tailnet lifecycle (login, logout, re-auth, identity reset), peer discovery, path health (direct vs. relayed + latency), session start/stop. |
| `internal/proxy/` | Per-session WebSocket→TCP bridge on `127.0.0.1`, guarded by a random token. |
| `internal/session/` | Wire types shared by the sidecar protocol and the mobile bindings. |
| `internal/config/` | Engine config and the tailnet hostname (`NomadVNC-<host>`). |
| `mobile/` | GoMobile-compatible API (strings in/out, JSON payloads, `PollEvents`). |

## Sidecar protocol

Each stdin line is a request, `{"id","method","params"}`; each stdout line
is either a reply `{"id","ok","result"|"error"}` or an event
`{"ok":true,"event":{...}}`. Requests run concurrently and are answered by
id. Methods: `ensureTailnetReady`, `getTailnetState`, `getTailnetPeers`,
`startVncSession`, `stopVncSession`, `getPeerPath`, `logoutTailnet`,
`reauthenticateTailnet`, `resetTailnetIdentity`. The TypeScript side lives in
`apps/desktop/src/main/sidecarManager.ts`.

`startVncSession` with `"direct": true` dials the target over the OS network
(typed LAN addresses — no tailnet needed); otherwise it dials through the
tailnet and requires a logged-in node. Stopping a session closes its live
WebSocket and TCP connections immediately.

## Environment

| Variable | Effect |
|---|---|
| `NOMADVNC_STATE_DIR` | Where the tailnet identity lives (the desktop app sets this to its user-data dir). |
| `NOMADVNC_AUTHKEY` / `--authkey` | Non-interactive tailnet login for headless installs. |
| `NOMADVNC_TS_CONTROL_URL` | Use a self-hosted coordination server (e.g. Headscale). |
| `NOMADVNC_TSNET_HOSTNAME` | Override the tailnet device name. |

## Commands (in `go-core/`)

```bash
go vet ./...
go test ./...          # add -race when touching the engine or proxy
```

From the repo root: `pnpm go:test`, `pnpm build:go` (builds the sidecar into
`go-core/bin/`, which is gitignored). Mobile bindings: see
`apps/mobile/NATIVE_SETUP.md`.
