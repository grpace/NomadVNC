# NomadVNC Privacy Policy

*Effective 5 October 2026.* Web version: <https://greg.tech/nomadvnc/privacy>

NomadVNC is free, open-source remote-desktop software made by Greg Pace.
This policy covers the NomadVNC apps (desktop and mobile) and the public
NomadVNC account server at `api.nomadvnc.dev.greg.tech`.

## The short version

- **No account is required.** In local mode nothing about you or your
  computers is sent to us.
- **No analytics, ads, or tracking.** The apps contain no analytics or
  advertising code and we never sell or share your data.
- **Your screen never passes through us.** Remote-desktop sessions go
  directly from your device to the computer you connect to.
- **Accounts are optional** and only store what's needed to sync your
  saved machines. You can delete your account at any time.

## Local mode (no account)

Saved machines and settings are stored only on your device. Saved VNC
passwords are kept in your operating system's secure storage (macOS/iOS
Keychain, Windows DPAPI, the Linux keyring, Android Keystore). Nothing is
sent to us.

## Remote-desktop connections

When you connect, the app talks directly to the computer you chose —
over your local network, or through Tailscale. We don't relay, see, or
record sessions, keystrokes, or clipboard contents.

Clipboard sync (optional, on by default) copies text between your device
and the remote computer during a session. On iOS the app reads your
clipboard only after you tap **Send Clipboard** in the Display menu; on
Android it reads the clipboard only when it changes during a session.

## Tailscale (optional)

If you choose **Sign in with Tailscale**, sign-in happens in your browser
with Tailscale, Inc. and the app joins your tailnet as a device. That
connection is governed by
[Tailscale's privacy policy](https://tailscale.com/privacy-policy). The
app's Tailscale identity is stored on your device.

## Nomad account (optional)

If you create an account on the public server, it stores:

| Data | Why |
|---|---|
| Your email address | Signing in (we email you a one-time link) |
| Saved machines: name, group, tailnet ID or address, VNC port, and the address last seen | Syncing them between your devices |
| VNC passwords you choose to sync | So your other devices can connect. Encrypted with AES-256-GCM; the encryption key is kept separately from the database. The server can decrypt them, so use your own server if that matters to you. |
| Shares: the email address you share a machine with, and an optional Tailscale key | Letting that person connect. The key is encrypted the same way. |
| Single-use sign-in and deletion links (stored as one-way hashes) | They expire after 15 and 60 minutes |

Sign-in emails are sent by a mail server I run
(they come from `notifications@mail.greg.tech`). The server and its
hosting may keep short-term technical logs (such as IP address, time,
and request) for security and abuse prevention; IP addresses are also
used briefly in memory to rate-limit sign-in requests.

We use this data only to run the sync and sharing features. We don't
share it with anyone, except if required by law.

### Your own server

You can point the apps at a server you run yourself
([self-hosting guide](https://github.com/grpace/NomadVNC/blob/master/docs/self-hosting.md)).
Data on that server is controlled by whoever runs it, not by us.

## Keeping and deleting your data

Account data is kept until you delete it. To delete your account and
everything synced to it:

- **In the app:** Account → **Delete Account** (desktop), or
  **Delete Account…** under your account on the mobile home screen.
- **Without the app:** <https://greg.tech/nomadvnc/delete-account> — we
  email you a link to confirm.

Deletion is immediate and permanent: your account, saved machines,
synced passwords, shares you created, and shares made to your email
address are removed. The public server doesn't currently keep database
backups; if that changes, backups will expire within 30 days and this
policy will be updated. Machines saved only on your devices aren't
affected — remove those in the app or by uninstalling it.

## Security

Connections to the account server use HTTPS. Tailscale connections are
end-to-end encrypted with WireGuard. Plain VNC on a local network is not
encrypted by the VNC protocol itself — use Tailscale on networks you
don't trust. See
[SECURITY.md](https://github.com/grpace/NomadVNC/blob/master/SECURITY.md)
to report a vulnerability.

## Children

NomadVNC isn't directed at children under 13, and we don't knowingly
collect their information.

## Changes

We'll post changes here with a new effective date. Significant changes
will also be noted in the release notes.

## Contact

Questions or requests: <hello@greg.tech>, or open an issue at
<https://github.com/grpace/NomadVNC/issues>.
