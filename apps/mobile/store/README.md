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

The app chrome in every picture is a real capture from the emulator.
In the two session pictures, the remote screen area shows a real
Xubuntu 24.04 desktop, added from `docs/images/hero.png` (see
[Updating Screenshots](#updating-screenshots)). iPhone screenshots
(6.9-inch, 1320×2868) are in `app-store/en-US/images/iphone/`. iPad
screenshots (13-inch, 2064×2752) are in `app-store/en-US/images/ipad/`.
Nothing in this folder has been submitted.

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

## Updating Screenshots

### What the Remote Screen Should Show

The remote computer in every picture should look like a normal
desktop: a real OS with a wallpaper, a panel or dock, and ordinary
windows. Avoid test patterns, `glxgears`, empty desktops, and
loopback addresses such as `127.0.0.1` in the session header. A
private LAN address such as `192.168.1.20` reads naturally.

The current pictures use one Xubuntu 24.04 desktop, 1600×1000, with
Thunar open on Documents and a text file in Mousepad. A 16:10 remote
screen fills the phone viewer at Fit Screen with no letterboxing.

### Reusing the Desktop From the README

`docs/images/hero.png` holds that desktop at 1275×797, at offset
(610, 405). If a live session can't be captured, crop it and place it
over the viewer's remote area. Find that area by its top-left border
pixel (`#DEDEDE`). In the Play pictures it is 1080 wide, at y 838 in
`03-session.png` and y 475 in `04-display.png`.

```bash
magick docs/images/hero.png -crop 1275x797+610+405 +repage remote.png
magick remote.png -filter Lanczos -resize 1080x676! remote-1080.png
magick 03-session.png remote-1080.png -geometry +0+838 -composite \
  -alpha off -strip PNG24:03-session.png
```

Update `docs/images/hero.png` and `docs/images/phone-session.png` in
the same pass, so GitHub, greg.tech, and the stores show the same
desktop. The greg.tech images are WebP copies of those two files.

### Android

Capture from an emulator or a phone with
`adb exec-out screencap -p > shot.png`, then crop the system bars
to 1080×2160 if needed. Turn on demo mode first, for a clean status
bar:

```bash
adb shell settings put global sysui_demo_allowed 1
adb shell am broadcast -a com.android.systemui.demo -e command clock -e hhmm 0941
adb shell am broadcast -a com.android.systemui.demo -e command battery -e level 100 -e plugged false
adb shell am broadcast -a com.android.systemui.demo -e command notifications -e visible false
```

### iOS

Only the home screen exists so far: `iphone/01-home.png` and
`ipad/01-home.png`. To match Play, add the same four pictures for
iPhone and iPad: Home with an address typed in, Settings, a live
session with the Touch Mode hint, and the session with Display open.

1. Boot the largest simulators: iPhone Pro Max (6.9-inch, 1320×2868)
   and iPad Pro 13-inch (2064×2752). Run the app from
   [NATIVE_SETUP.md](../NATIVE_SETUP.md).
2. Clean up the status bar before every capture:

   ```bash
   xcrun simctl status_bar booted override --time 9:41 \
     --batteryState charged --batteryLevel 100 \
     --wifiBars 3 --cellularMode active --cellularBars 4
   ```

3. Capture: `xcrun simctl io booted screenshot 02-settings.png`.
4. Remove the alpha channel, which App Store Connect rejects:
   `magick shot.png -alpha off PNG24:shot.png`.
5. For the session pictures, connect to a real desktop. The simulator
   shares the Mac's network, so a VNC server on the LAN or on the Mac
   itself works. If that isn't possible, use the hero desktop as
   described above.

Retake the existing iOS home pictures in the same pass. The iPhone
one shows 6:52 in the status bar. The iPad one has the iPadOS
window-resize handle in the bottom-right corner, over the Connect
button's shadow. Full-screen the app (or turn off Stage Manager)
before capturing.

Pick one appearance per store. The Play pictures are dark. The
existing iOS pictures are light. Either is fine, as long as every
picture in one listing matches.
