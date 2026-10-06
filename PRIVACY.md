# NomadVNC Privacy Policy

*Effective 6 October 2026.* Web version: <https://greg.tech/nomadvnc/privacy>

NomadVNC is free, open-source remote desktop software made by Greg Pace.
This policy covers the NomadVNC apps, NomadVNC Host, and the public
NomadVNC account server at `api.nomadvnc.dev.greg.tech`.

## The Short Version

- **No account is required.** In Local Mode, nothing about you or your
  computers is sent to us.
- **No analytics, ads, or tracking.** The apps contain no analytics or
  advertising code, and we never sell or share your data.
- **Your screen never passes through us.** Sessions go directly from
  your device to the computer you connect to.
- **Accounts are optional.** They only store what's needed to sync and
  share your saved computers. You can delete yours at any time.

## Local Mode (No Account)

Saved computers and settings are stored only on your device. Saved VNC
passwords are kept in your operating system's secure storage: macOS and
iOS Keychain, Windows DPAPI, the Linux keyring, or Android Keystore.
Nothing is sent to us.

## Remote Desktop Connections

When you connect, the app talks directly to the computer you chose, over
your local network, a VPN you use, or Tailscale. We don't relay, see, or
record sessions, keystrokes, or clipboard contents.

Clipboard sync is optional and on by default. It copies text between
your device and the remote computer during a session. On iOS, the app
reads your clipboard only after you tap **Send Clipboard**. On Android,
it reads the clipboard only when it changes during a session.

NomadVNC Host, the optional Windows server, runs on your PC and sends
nothing to us.

## Tailscale (Optional)

Tailscale is built into the app and stays off until you choose **Sign in
with Tailscale**. Sign-in happens in your browser with Tailscale Inc.,
and the app joins your tailnet as its own device. It is separate from
the Tailscale app, and only NomadVNC traffic uses it. That connection is
governed by
[Tailscale's privacy policy](https://tailscale.com/privacy-policy). The
app's Tailscale identity is stored on your device.

## Nomad Account (Optional)

If you create an account on the public server, it stores:

| Data | Why |
|---|---|
| Your email address | Signing in. We email you a one-time link. |
| Saved computers: name, group, tailnet ID or address, VNC port, and the address last seen | Syncing them between your devices. |
| VNC passwords you choose to sync | So your other devices can connect. Encrypted with AES-256-GCM, with the key kept separately from the database. The server can decrypt them, so run your own server if that matters to you. |
| Shares: the email address you share a computer with, and an optional Tailscale key | Letting that person connect. The key is encrypted the same way. |
| Single-use sign-in and deletion links, stored as one-way hashes | They expire after 15 and 60 minutes. |

Sign-in emails are sent by a mail server run by the maintainer and come
from `notifications@mail.greg.tech`. The server and its hosting may keep
short-term technical logs, such as IP address, time, and request, for
security and abuse prevention. IP addresses are also held briefly in
memory to rate-limit sign-in requests.

We use this data only to run sync and sharing. We don't share it with
anyone, except when required by law.

### Your Own Server

You can point the apps at a server you run yourself. See the
[self-hosting guide](https://github.com/grpace/NomadVNC/blob/master/docs/self-hosting.md).
Data on that server is controlled by whoever runs it, not by us.

## Updates

The desktop app checks GitHub Releases for new versions in the
background, and downloads updates from there. GitHub sees those
requests like any download. You can turn automatic checks off in the
app under **Settings**, then **Updates**. The phone apps don't check for
updates.

## Keeping and Deleting Your Data

Account data is kept until you delete it. To delete your account and
everything synced to it:

- **On a computer:** open the **Account** tab, expand **Delete
  Account**, choose **Delete Account…**, and confirm.
- **On a phone:** open **Settings**, go to **Account**, tap **Delete
  Account…**, and confirm.
- **Without the app:** request deletion at
  <https://greg.tech/nomadvnc/delete-account>. We email you a link to
  confirm.

Deletion is immediate and permanent. Your account, saved computers,
synced passwords, shares you created, and shares made to your email
address are removed. The public server doesn't currently keep database
backups. If that changes, backups will expire within 30 days and this
policy will be updated.

Computers saved only on your devices stay on those devices. Remove them
in the app, or uninstall the app.

## Security

Connections to the account server use HTTPS. Tailscale connections are
end-to-end encrypted with WireGuard. Plain VNC on a local network is not
encrypted by the VNC protocol itself, so use Tailscale or another VPN on
networks you don't trust. To report a vulnerability, see
[SECURITY.md](https://github.com/grpace/NomadVNC/blob/master/SECURITY.md).

## Children

NomadVNC isn't directed at children under 13, and we don't knowingly
collect their information.

## Changes

We'll post changes here with a new effective date. Significant changes
will also be noted in the release notes.

6 October 2026: new sign-in email address, any VPN alongside Tailscale,
desktop update checks, NomadVNC Host, and current deletion steps.

## Contact

Questions or requests: <hello@greg.tech>, or open an issue at
<https://github.com/grpace/NomadVNC/issues>.
