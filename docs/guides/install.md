# Installing NomadVNC

Downloads are on the [Releases page](https://github.com/grpace/NomadVNC/releases)
— pick the file for your system below.

## Updates

The desktop app checks for new releases in the background (shortly after
launch, then every few hours), downloads them, and shows **Restart and
install** under **Settings → Updates** — where you can also check by hand
or turn automatic checks off.

| Install | How it updates |
|---|---|
| Windows installer, Linux AppImage | Fully automatic. |
| Linux `.deb` / `.rpm` | Automatic; asks for your password to install. You can also install the new file with your package manager. |
| macOS | Automatic once releases are code-signed. Until then the app tells you a new version is out and links to the download. |
| Android | Install the new APK from Releases. Android updates the app in place when the signature matches. |
| iOS | Not in the App Store yet — rebuild from source. |

Updates come only from this repository's GitHub Releases.

## Linux

Pick one of the three formats for x86_64:

| File | Install |
|---|---|
| `NomadVNC-<version>-x86_64.AppImage` | `chmod +x NomadVNC-*.AppImage && ./NomadVNC-*.AppImage` — no root, any distro |
| `NomadVNC-<version>-amd64.deb` | `sudo apt install ./NomadVNC-*-amd64.deb` (Debian, Ubuntu, Mint, Pop!_OS) |
| `NomadVNC-<version>-x86_64.rpm` | `sudo dnf install ./NomadVNC-*.rpm` (Fedora, RHEL, openSUSE) |

The `.deb`/`.rpm` install a `nomadvnc` command and a menu entry, and
register `nomadvnc://` links (used by account sign-in emails). In-app
updates of a package install may ask for your password.

### Saving passwords on Linux

NomadVNC encrypts saved passwords with your desktop keyring through the
Secret Service (D-Bus). It works out of the box on GNOME (gnome-keyring)
and KDE (KWallet) when you start the app from a normal graphical login.
If **Save Password Securely** is greyed out:

- GNOME/XFCE/Cinnamon: install `gnome-keyring` and `libsecret`.
- KDE: enable KWallet (System Settings → KDE Wallet) and unlock it.
- Tiling window managers / minimal sessions: make sure a keyring daemon
  runs in your session, then pick the backend explicitly:

  ```bash
  NOMADVNC_PASSWORD_STORE=gnome-libsecret nomadvnc   # or kwallet5 / kwallet6
  ```

Avoid `NOMADVNC_PASSWORD_STORE=basic`: it "encrypts" with a fixed,
publicly known key, which is no better than plain text.

### Tiling window managers

NomadVNC draws its own title bar. On i3, Sway, Hyprland and similar, turn
on **Settings → Window → Use Native Window Frame** (or launch with
`NOMADVNC_NATIVE_FRAME=1`).

## macOS (Apple Silicon)

Open `NomadVNC-<version>-arm64.dmg` and drag NomadVNC to Applications.

Until releases are signed and notarized, macOS blocks the first launch
("NomadVNC can't be opened" or "is damaged"). Either right-click the app →
**Open** → **Open**, or run once:

```bash
xattr -dr com.apple.quarantine /Applications/NomadVNC.app
```

## Windows (64-bit)

Run `NomadVNC-<version>-x64.exe`. The installer asks whether to install
for you only or for everyone on the computer, which folder to use, and
whether to start NomadVNC when setup finishes. It adds Start menu and
desktop shortcuts, and registers `nomadvnc://` links for account sign-in.

Uninstall from Windows **Settings → Apps**, or from **Settings → Updates
→ Uninstall** in NomadVNC. The uninstaller asks whether to delete saved
machines and settings for your Windows account. An update does not
delete them.

Until releases are code-signed, SmartScreen warns about an unknown
publisher: choose **More info → Run anyway**.

### NomadVNC Host (optional)

`NomadVNC-Host-<version>-x64.exe` on the same Release page is a separate
program. It shares a Windows PC's screen. The viewer does not need it, and
it does not update when the viewer does. Until releases are code-signed,
SmartScreen warns about this file too.

If you manage a fleet of computers, this is the easy configuration on each
Windows PC: one command, then it starts at boot with no window. The steps
are in [A fleet of Windows PCs](windows-macos-server.md#a-fleet-of-windows-pcs).

## Android

Download `NomadVNC-<version>.apk` from the
[Releases page](https://github.com/grpace/NomadVNC/releases) and open it.
Android asks you to allow installs from your browser or files app the
first time. The Play Store listing is not live yet. The APK is 64-bit
(phones, and the Android emulator). Listing copy and screenshots are in
[apps/mobile/store](../../apps/mobile/store). Building from source is in
[apps/mobile/NATIVE_SETUP.md](../../apps/mobile/NATIVE_SETUP.md).

## iOS

Not on the App Store yet. The app runs on iPhone and iPad. Build it
from source with
[apps/mobile/NATIVE_SETUP.md](../../apps/mobile/NATIVE_SETUP.md).
Listing copy and screenshots for Play and the App Store are in
[apps/mobile/store](../../apps/mobile/store). Nothing there has been
submitted.

## Headless and scripted installs

On a machine with no browser for the Tailscale sign-in, give the app an
auth key instead:

```bash
NOMADVNC_AUTHKEY=tskey-auth-... nomadvnc
```

To use a self-hosted coordination server (e.g. Headscale), set
`NOMADVNC_TS_CONTROL_URL`. Details: [linux-server.md](linux-server.md#running-the-client-itself-headless).

## Where NomadVNC keeps its data

| | Linux | macOS | Windows |
|---|---|---|---|
| App data | `~/.config/NomadVNC/` | `~/Library/Application Support/NomadVNC/` | `%APPDATA%\NomadVNC\` |

That folder holds the tailnet identity (`sidecar-state/`), the encrypted
password store, and settings. Deleting it resets the app; the tailnet
device then reappears as a new device in your Tailscale admin console.
