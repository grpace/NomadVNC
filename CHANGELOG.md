# Changelog

All notable changes to NomadVNC. Versions follow
[semantic versioning](https://semver.org/); dates are release dates.

## 1.1.0 — 2026-10-10

- Nomad account sign-in no longer expires after a day. A sign-in lasts a year and renews whenever the app is opened, so an app you use stays signed in until you sign out. Self-hosted servers: remove `JWT_EXPIRES_IN` or set it to `365d` if you set it to `24h`.
- Sessions show **Slow** or **Not Responding** when the remote computer is late to answer, and say whether the network still reaches it. A session that stops answering for about 20 seconds reconnects on its own instead of freezing until you reconnect by hand.
- **Reconnect** is always in the session toolbar (desktop and phone), so a stuck session can be cycled at once instead of waiting.
- On a phone, sessions to a typed address are no longer held at low image quality. Auto quality took them for unreachable tailnet devices.
- The account server's Docker image builds again. `npm install` crashed during peer-dependency resolution, so deploys after 1.0.0 failed and kept the old server running.

- On iPhone, launch no longer flashes "Connect to Metro to develop JavaScript" and then goes black. That message was a debug window drawn over the app.
- The privacy policy now names the current sign-in email address, covers any VPN, desktop update checks, and NomadVNC Host, and gives the current steps to delete an account on a phone.
- The macOS install notes cover **Open Anyway** in System Settings, which macOS 15 and later require for unsigned apps.
- `proxy-addr` is 2.0.8 and Metro uses `image-size` 2.0.4, which closes the open dependency advisories.

## 1.0.0 — 2026-10-05

First public release.

NomadVNC is a remote desktop for any computer you have access to, on
Linux, macOS, Windows, Android, and iOS.

- Connect on your local network with no account. From somewhere else,
  use any VPN that can reach the computer. Tailscale is built in and
  stays off until you choose **Sign in with Tailscale**.
- Save a computer and connect again in one tap. Passwords stay in the
  OS keychain. An optional Nomad account syncs saved computers and
  encrypted passwords, and can share a computer by email.
- The home screen leads with your computers. Settings holds the account
  server, this device's tailnet name, and account deletion.
- The viewer fits the remote screen, shows it at actual size, or zooms.
  Wide screens can show one half. Touch and Trackpad modes cover
  phones, tablets, and touchscreen laptops.
- On iPhone, **Send Clipboard** is in the Display menu. A dot on the
  Display button means the phone clipboard has something new.
- Android installs from `NomadVNC-<version>.apk` on this Release. iOS
  runs on iPhone and iPad. Store listings are prepared and not
  submitted yet.
- NomadVNC Host, for 64-bit Windows, is an optional download on the
  same Release. It shares that PC, including the sign-in screen, and
  can start at boot. The viewer does not need it. Any VNC server still
  works.

[1.0.0]: https://github.com/grpace/NomadVNC/releases/tag/v1.0.0
