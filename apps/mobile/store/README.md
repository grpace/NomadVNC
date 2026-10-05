# Store listings

Paste-ready copy and graphics for the Play Store and the App Store.
Nothing here has been submitted. Uploading needs the maintainer's
Google Play and Apple Developer accounts, which are not created by
the repo.

| | |
|---|---|
| Privacy policy | https://greg.tech/nomadvnc/privacy |
| Support | https://greg.tech/nomadvnc/support |
| Account deletion | https://greg.tech/nomadvnc/delete-account |
| Product page | https://greg.tech/nomadvnc |
| Contact email | hello@greg.tech |
| Version | 1.0.0 (Android `versionCode` 1, iOS build 1) |

## Play Store

Text is in `play/en-US/`. Graphics are in `play/en-US/images/`.

| File | Play rule |
|---|---|
| `title.txt` | 30 characters |
| `short_description.txt` | 80 characters |
| `full_description.txt` | 4,000 characters |
| `images/phone/*.png` | 1080×2160, 24-bit PNG, no transparency. This is the 2:1 maximum Play accepts. |
| `images/feature-graphic.png` | 1024×500, 24-bit PNG, no transparency |
| `images/icon-512.png` | 512×512 PNG |

Phone screenshots, in order:

1. Home, with a manual address filled in.
2. Settings: scale, quality, clipboard, and touch gestures.
3. A live session, with the toolbar and the touch hint.
4. The same session with display options open.

The session pictures are a real connection to a local desktop.
iPhone screenshots (6.9-inch, 1320×2868) are in
`app-store/en-US/images/iphone/`. iPad screenshots are in
`app-store/en-US/images/ipad/` when captured. Nothing in this
folder has been submitted.

Suggested console answers:

- App name: NomadVNC
- Category: Tools
- Tags: Remote desktop, VNC
- Contact: hello@greg.tech
- Privacy policy URL: the table above
- Ads: no
- Content rating: no violence, no user-generated public content, no
  unrestricted web. The questionnaire should land on Everyone.
- Release: upload `app-release.aab` from `bundleRelease` (see
  [docs/releasing.md](../../../docs/releasing.md)). The upload key
  stays outside the repo.

Data safety, stated the way the app actually behaves:

- No ads and no analytics SDK.
- Without an account, machine names, addresses, and passwords stay on
  the device. Passwords use Android credential storage.
- With an account, the app sends the email address, saved machines,
  and passwords encrypted for the account server. The server can
  decrypt those passwords. Say that; do not mark the account data as
  end-to-end encrypted.
- The app connects to VNC servers the user chooses, and to Tailscale
  only after the user signs in.

## App Store

Text is in `app-store/en-US/`.

| File | App Store rule |
|---|---|
| `name.txt` | 30 characters |
| `subtitle.txt` | 30 characters |
| `promotional_text.txt` | 170 characters, editable without a new build |
| `keywords.txt` | 100 characters, commas, no space after a comma |
| `description.txt` | 4,000 characters |
| `whats_new.txt` | What's New for 1.0.0 |
| `privacy_url.txt`, `support_url.txt`, `marketing_url.txt` | the live pages |

Suggested console answers:

- Primary category: Utilities
- Age rating: 4+
- Copyright: 2026 Greg Pace
- Export compliance: `ITSAppUsesNonExemptEncryption` is false (standard
  encryption only)

iPhone screenshots are 1320×2868, the 6.9-inch size App Store
Connect accepts. iPad screenshots are 2064×2752, the 13-inch size.
Both were captured from the simulators, not resized from Android.
