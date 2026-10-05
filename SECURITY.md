# Security

## Reporting a vulnerability

Please report security issues **privately** through GitHub:
**Security → Report a vulnerability** on this repository. Don't open a
public issue for anything that could put users at risk.

Include what's affected (app and version, or a commit), how to reproduce
it, and the impact you expect. You'll get an acknowledgement as soon as
the maintainer sees it; fixes for confirmed issues ship in the next
release, with credit if you'd like it.

Security fixes go into the latest release only.

## Security model

What NomadVNC protects, and what it doesn't:

**VNC passwords and tokens**
- Saved passwords are encrypted with the operating system's secure
  storage (macOS/iOS Keychain, Windows DPAPI, libsecret/KWallet on Linux,
  Android Keystore). They never appear in machine records, settings files,
  or logs.
- Account session tokens are stored the same way.

**Network**
- Connections through the built-in Tailscale node are end-to-end
  encrypted with WireGuard.
- **Plain VNC on a local network is not encrypted** (VNC's own password
  check is a weak challenge-response). Use Tailscale, or only connect
  directly on networks you trust.
- The viewer talks to the engine through a WebSocket on `127.0.0.1` that
  requires a random per-session token. On mobile, other apps on the device
  can reach loopback ports; the token is what keeps them out.
- The embedded Tailscale node is never started — and Tailscale's servers
  are never contacted — until you choose to sign in.

**Desktop app**
- The UI runs sandboxed with context isolation and a strict Content
  Security Policy (no remote scripts; network access only to the local
  session proxy). Privileged work happens in the main process behind
  validated IPC.
- The window can't be navigated to other pages; external links open in
  your browser only if they are `http(s)`.

**Account server** (optional)
- Sign-in is passwordless: single-use email links that expire in 15
  minutes; only token hashes are stored.
- Synced passwords and shared tailnet keys are encrypted at rest with
  AES-256-GCM. **The server can decrypt them** — this is not end-to-end
  encryption. The encryption key lives only in the server's environment,
  never in the database.
- If you don't want to trust the public server, [self-host
  it](docs/self-hosting.md).

## Scope

In scope: the apps in `apps/`, the engine in `go-core/`, the account
server in `backend/`, and the packaging/CI configuration. Out of scope:
vulnerabilities in VNC servers themselves, in Tailscale, or in a
self-hoster's own infrastructure — though tell us if NomadVNC makes one
worse.
