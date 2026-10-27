# Changelog

All notable changes to NomadVNC. Versions follow
[semantic versioning](https://semver.org/); dates are release dates.

## Unreleased

## 1.3.1 — 2026-10-27

- The desktop app now runs on Electron 42. Electron 41 no longer gets security fixes, and the newer version closes a batch of published Electron vulnerabilities, including a certificate-trust mitigation, several permission-origin checks, and a SameSite cookie fix.
- Updated the libraries behind the account backend and the apps (`body-parser`, `fast-uri`, `qs`, `undici`, and `nodemailer`) to versions that fix published denial-of-service and parsing problems.

## 1.3.0 — 2026-10-23

- The desktop app can keep several computers open at once. Connecting to another computer no longer asks you to disconnect the first; the new one opens beside it. With two or more open, a row of tabs appears above them: **Show All Side by Side** tiles every screen in the window, and **One at a Time** shows one with the rest a tab away. Each session keeps its own connection, reconnects on its own, and is disconnected on its own. The layout is remembered.
- With a group selected in the machine list, **Connect All** opens every computer in it and tiles them, for example the machines behind a wall of displays. Computers that ask for a password ask one after another.
- With several sessions open, keys, the keyboard capture and the clipboard go to the one you last clicked, outlined in the tiled view. Copying on one remote computer and pasting on another works.
- A saved computer that is already open says **Show** instead of **Connected**; clicking it brings that session forward.

## 1.2.0 — 2026-10-13

- NomadVNC Host is much smoother. It compresses the screen (Tight, with JPEG for photos and video, and ZRLE for RealVNC) instead of sending raw pixels, and NomadVNC viewers get a steady stream of changes instead of asking for each frame. In tests with a NomadVNC viewer, an animated screen went from about 14 to about 60 frames a second on a local network, and from about 14 to about 35 over a link with a 50 ms round trip.
- NomadVNC Host follows the viewer's quality setting: lower settings send photos and video as smaller JPEG, **Lossless** sends exact pixels, and text and flat areas stay sharp at every setting. When the viewer raises quality, for example once input stops, the blurred parts are resent sharp.
- Typing works on a NomadVNC Host PC. Before, every key press was dropped: the host gave Windows a key event of the wrong size, and Windows refused it. Only the mouse worked.
- A locked NomadVNC Host PC shows its lock screen and can be unlocked from the viewer. Before, it showed a broken picture of the desktop behind the lock. Windows approval prompts ("Do you want to allow this app to make changes?") show and can be answered, and windows that run as administrator take clicks and keys. One connection lasts through locking, unlocking and signing in; before, signing in dropped it.
- Keys reach a NomadVNC Host PC as key presses on that PC's own keyboard layout, so shortcuts such as Ctrl with + or - work. Characters the layout has no key for, and capitals and symbols from a phone keyboard, are typed as text. Insert, Caps Lock, Print Screen, the Menu key, the number pad and the right-hand Shift, Ctrl and Alt are sent as well.
- When a viewer disconnects while holding a key or dragging, the PC lets go of it.
- NomadVNC Host's setup window has a new look. It shows the logo, whether the host is running, and what each field is for, and it is light or dark to match Windows. The black console window no longer opens behind it.
- NomadVNC Host's setup window no longer freezes during **Sign In with Tailscale**. Before, it stopped responding while the sign-in ran and Windows offered to close it.
- NomadVNC Host can use a port other than 5900: set **Port** in its window, or pass `--port`. The firewall rule follows it.
- NomadVNC Host shows an icon in the system tray while someone is signed in. Pointing at it says whether the screen is being shared and on which port, and clicking it opens the setup window. `--no-tray` on the install command leaves it out.
- NomadVNC Host is listed under **Installed apps** in Windows Settings, with its version, and can be uninstalled from there. Uninstalling removes its program folder. Before, uninstalling from the Start menu shortcut left the program on the PC.
- Upgrading NomadVNC Host while its setup window is open works. Before, the upgrade failed and left the host stopped, so the PC could not be reached. An install that fails for any other reason now starts the host again.
- The NomadVNC Host exe carries its name, version and icon, and `--version` prints the version. In a script, run it with `start /wait` so the command prompt waits for it to finish.
- Clicks reach a NomadVNC Host PC at once even while the screen is updating. Before, input could wait up to a second behind a screen capture on a still screen. Moving the pointer over a still screen now shows on the viewer too.
- NomadVNC Host always starts on its fast screen capture and returns to it after an interruption. Before, a session that started at the wrong moment stayed on the slow one.
- The pointer is drawn by the viewer from its shape, so it moves without delay on any link and moving it costs no screen updates. Viewers that can't draw it (older ones) still get it in the picture, and moving it over a still screen now shows there too.
- NomadVNC Host's saved VNC password and Tailscale key are readable only by Windows administrators and the service. Before, any user account on the PC could read both. The screen process gets what it needs from the service instead. Installing or starting this version fixes existing installs.
- NomadVNC Host only hands viewers to the screen process it started, so another program on the PC can't pose as it to see what remote users type.
- After three wrong VNC passwords, each further attempt waits longer, up to 30 seconds. A connection that doesn't finish signing in within a minute is closed, and NomadVNC Host carries at most 32 connections at a time.
- NomadVNC Host stays reachable while Tailscale sign-in waits for key expiry to be turned off; before, the service stayed stopped until then, or until the setup window closed. The service also checks its Tailscale connection and reconnects if it has been down for two minutes, and Windows now restarts the service if it ever stops with an error. If the screen process can't start, for example because another program has its port, the service retries less and less often instead of every two seconds.
- On the desktop, the status line stops saying "Connection lost. Retrying (1/5)…" once the session has reconnected. Before, it kept saying so for the rest of the session.
- On a phone, a session that drops and can't be reconnected is titled **Connection Lost** and says how many tries failed and what to check. Before, it was titled "Couldn't Connect", as if it had never worked.
- Viewers no longer turn compression off at the higher quality settings, which flooded slower links when connecting to other VNC servers, and they move screen data through the app's relay in larger pieces.

## 1.1.2 — 2026-10-13

- Signing out of a Nomad account signs out only that device. Your other phones and computers stay signed in. **Sign Out of All Devices** (phone: Settings → Account; desktop: Account) signs out everywhere, for example after losing a phone.
- On iPhone and Android, connecting to a Mac that asks for its username and password no longer stalls and retries. The viewer couldn't run the encryption that Apple's sign-in needs; it now loads from a secure local address. A sign-in step that fails ends the attempt at once instead of after 20 seconds.

## 1.1.1 — 2026-10-13

- On a phone, saved computers can be edited: name, address, port, group, Mac username, and password. A shared computer keeps its address until its shares are removed.
- The Mac username for macOS Screen Sharing is saved with each computer and syncs through the Nomad account to your other devices, desktop included.
- On a phone, picking a computer from your tailnet shows its own password, Mac username, and port. Picking one no longer connects to an address left in Manual Connection.
- When a Mac asks for credentials, the phone's sign-in screen asks for the Mac username too, and saves one that works to that computer.
- NomadVNC Host works with more VNC viewers, such as RealVNC Viewer. Low or medium picture quality no longer garbles the screen: the host sends 8-bit, 16-bit, and palette color when a viewer asks. Viewers that speak older VNC versions (3.3 and 3.7) can connect, a change of screen resolution resizes the viewer instead of breaking it, and viewers that list many encodings are no longer disconnected.

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
