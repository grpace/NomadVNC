# Changelog

All notable changes to NomadVNC. Versions follow
[semantic versioning](https://semver.org/); dates are release dates.

## Unreleased

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
