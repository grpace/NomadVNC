# Architecture

NomadVNC is a pnpm + Turborepo monorepo with a Go engine.

```
apps/desktop   Electron app (Linux, macOS, Windows)
apps/mobile    React Native app (Android, iOS)
go-core        Go engine: embedded Tailscale node + per-session VNC proxy
backend        Optional account server (Node.js + PostgreSQL)
packages/
  domain               shared types (machines, peers, sessions) and rules
  platform-contracts   the native bridge API both apps implement
  viewer-shell         noVNC viewer document + typed postMessage protocol
```

## The connection path

```
noVNC (in the app)  --ws://127.0.0.1:<port>/vnc?token=…-->  Go proxy  --TCP-->  VNC server
                                                              │
                                     direct: OS network ──────┤
                                     tailnet: tsnet (WireGuard)
```

1. The app asks the engine to start a session for `host:port`.
2. The engine opens a WebSocket listener on `127.0.0.1` with a random
   ephemeral port and a random token, and returns its URL.
3. The viewer — [noVNC](https://github.com/novnc/noVNC) in an iframe
   (desktop) or WebView (mobile) — connects to that URL. Only then does the
   engine dial the VNC server and pipe bytes both ways.
4. **Direct** sessions (an address you typed) dial over the normal network.
   **Tailnet** sessions dial through the embedded Tailscale node.
5. Disconnecting closes the proxy and both connections immediately.

VNC authentication happens between noVNC and the VNC server; the proxy
never sees or stores the password.

### The embedded Tailscale node

The engine embeds [`tsnet`](https://pkg.go.dev/tailscale.com/tsnet): a
Tailscale device that lives inside NomadVNC, with its own identity stored
in the app's data folder. It carries only NomadVNC's traffic — the OS
network configuration is untouched and no system VPN is installed.

Until the user signs in to Tailscale for the first time, the node is
never started — the app makes no contact with Tailscale's servers at all.
Sign-in is always an explicit action. After that, the node comes up with
the app (to keep the device list current) and stops when the app quits.
Settings can name the node. An empty name uses NomadVNC- plus the device
name. iOS does not use the sandbox hostname, which is localhost. Changing
the name does not start Tailscale. A node that is already connected is
renamed in place.

## Optional Windows host

`go-core/cmd/nomadvnc-host` is a separate 64-bit Windows program, not part
of the viewer. It shares that PC's screen on port 5900, including the
Windows sign-in screen, and starts at boot after setup. Any VNC viewer
can connect, including NomadVNC, and the viewer stays usable with any
other VNC server. On the local network, no VPN is required. From
somewhere else, any VPN that can reach port 5900 works. Tailscale sign-in
inside the host is optional. It uses its own tsnet node, started only
after the person chooses it, and setup does not call that sign-in
finished until key expiry is off. Releases attach it as
`NomadVNC-Host-<version>-x64.exe`, separate from the viewer installer.
A silent install is documented for people who manage a fleet of PCs.

## Desktop (Electron)

- **Main process** owns everything privileged: the Go sidecar
  (`main/sidecarManager.ts`, JSON over stdin/stdout — protocol in
  [go-core/README.md](../go-core/README.md)), encrypted secret storage
  (`main/credentialStore.ts`, Electron `safeStorage`), account-server HTTP
  (`main/accountHttp.ts`), auto-update, and `nomadvnc://` deep links.
- **Renderer** (React) has no Node access. It runs sandboxed with context
  isolation and reaches the main process only through the typed bridge in
  `preload/preload.ts` (`window.nomadNative`).
- **Content Security Policy:** the renderer may only connect to loopback
  (the session proxy). The viewer iframe has its own stricter policy with
  no remote script sources.
- **Navigation:** the window can't navigate away from the app; external
  links open in the system browser only if they are `http(s)`.

## Mobile (React Native)

The Go engine is compiled with GoMobile into `Mobile.xcframework` /
`mobile.aar` and called from small native modules
(`ios/NomadVNC/NomadNativeModule.swift`,
`android/.../NomadNativeModule.kt`), which also provide Keychain/Keystore
storage, the clipboard (plus a contents-free change token), and a
loopback server for the viewer's JavaScript files. The JavaScript side mirrors desktop behaviour on top of the same
`platform-contracts` API. Build details: [apps/mobile/NATIVE_SETUP.md](../apps/mobile/NATIVE_SETUP.md).

## Viewer protocol

`packages/viewer-shell` builds the viewer document and defines the typed
messages between app and viewer: commands (`sendKeys`, `typeText`,
`setScaleMode`, `setDisplayRegion`, `setPointerMode`, `resetView`,
`setQuality`, `clipboardPaste`, …) and events (`viewerState` —
`connected`, `disconnected`, `credentialsRequired`, `authFailed` — plus
clipboard, resize, zoom, and activity events for adaptive quality). The
viewer accepts commands only from its embedding app.

The viewer is three local scripts, never fetched remotely: noVNC,
`bootstrap.mjs` (connection, view, and the command channel), and
`input.mjs` (touch gestures and text-to-keysym typing — pure logic with
its own unit tests). Scaling, zoom, monitor halves, and pinch-zoom all use
noVNC's display viewport rather than CSS transforms, so pointer
coordinates stay exact; a view larger than the window is clipped and pans
(touch drag, or the mouse held at an edge). Touch gestures are handled
before noVNC sees them and become pointer events in remote coordinates,
in either Touch (direct) or Trackpad (relative) mode.

On mobile, the phone keyboard types into a hidden text field; each edit
is diffed and replayed as Backspaces plus typed text (`softKeyboard.ts`).
Clipboard sync polls only a change token from the OS (never the
contents), reading the clipboard once per actual change on Android and
only after a tap on iOS.

## Saved machines

A saved machine records a label, its address, VNC port, optional
username, group, and how its password is kept (`prompt`, `localSecure`
= OS keychain on this device, `cloudSecure` = synced through the
account). Passwords are never part of the machine record.

Machines are keyed by identity, not IP:

- **Tailnet machines** use the device's stable Tailscale ID, so they
  survive IP and name changes.
- **Address-only machines** use `manual:<host>` and always dial directly
  (`isManualMachine` in `packages/domain`).

Connection errors are classified honestly: a rejected password asks for a
new one and never retries automatically; a session that never connected
reports "couldn't connect"; only drops of a live session auto-reconnect
with backoff.

## Account server

`backend/` — Express + PostgreSQL. Self-hosting guide:
[self-hosting.md](self-hosting.md).

### Sign-in

Passwordless. `POST /api/v1/auth/magic-link {email}` emails a single-use
link, valid for 15 minutes; only a SHA-256 hash of the token is stored.
The button is `https://<server>/auth/open?token=…` because webmail will
not open `nomadvnc://` links. That page asks the browser to open
`nomadvnc://auth/callback?token=…`. Desktop, iOS, and Android all
register that address and sign in from it, including when the app is
already open. The email also includes that address for paste. The response is identical whether or not the address
has an account. The app redeems it with
`POST /api/v1/auth/consume {token}` (atomic, single use) for a session JWT
(HS256). `POST /api/v1/auth/logout` bumps the user's credential version,
signing out every session at once. Tokens are kept in the OS keychain.

### API

All under `/api/v1`, JSON, `Authorization: Bearer <jwt>` except auth and
the web deletion flow.
Errors are `{"error": "…"}`.

| Method & path | Purpose |
|---|---|
| `GET /devices` | Your saved machines |
| `PUT /devices` | Create or update a machine (keyed by stable ID + port) |
| `DELETE /devices/:id` | Delete a machine |
| `PUT /devices/:id/credential` | Store its VNC password (encrypted) |
| `GET /devices/:id/credential` | Fetch it (owner, or a grantee with a live share) |
| `DELETE /devices/:id/credential` | Forget it |
| `GET /devices/shared` | Machines shared with you (no secrets) |
| `POST /devices/:id/shares` | Share by email, optionally with a tailnet auth key |
| `GET /devices/:id/shares` | List shares |
| `PUT /devices/:id/shares/:shareId` | Replace or remove the attached key |
| `DELETE /devices/:id/shares/:shareId` | Revoke (takes effect immediately) |
| `DELETE /account` | Delete your account and everything tied to it |
| `POST /account/deletion-request` | Web form: email a deletion link (`{email}`, form or JSON) |
| `GET`/`POST /account/delete?token=…` | Confirm page / perform a web deletion (single-use link) |
| `GET /health` | Liveness |

### Data and encryption

Tables: `users`, `magic_links`, `devices`, `device_credentials`,
`shares`, `share_keys`, `data_keys` (key fingerprints only).

Passwords and shared tailnet keys are encrypted with AES-256-GCM under
`DATA_KEY`, with a random nonce and additional authenticated data that
binds each value to its device and owner (or share), so ciphertext can't
be moved between records. The key comes only from the environment and
supports rotation. **The server can decrypt these values** — this protects
data at rest and in backups, not against the server operator.

### Sharing

An owner can grant another email address access to one machine. The
grantee sees it under *Shared With Me* and can fetch its VNC password
while the share exists; revoking removes access and deletes any attached
key. The grantee still needs a network route to the machine — typically
by being on the same tailnet; an attached Tailscale auth key is passed
along as their connect credential.

### Hardening

Async errors return JSON instead of crashing the process; malformed IDs
are rejected before reaching the database; sign-in requests are
rate-limited per client IP; email content is HTML-escaped; the process
drains connections on `SIGTERM`.
