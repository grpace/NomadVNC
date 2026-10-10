# Using NomadVNC

How to work in a remote session on desktop and mobile. Setting up the
computer you connect to is covered in the [setup guide](README.md).

## Desktop (Linux, macOS, Windows)

### Menu bar

On macOS the menu bar at the top of the screen has NomadVNC, File, Edit,
View, Window, and Help. Settings is under the NomadVNC menu
(Command-comma). Edit is what makes cut, copy, and paste work in the
app's text fields. Help opens this guide.

### Fitting the screen

The viewer toolbar has three scale options:

- **Fit** — the whole remote screen, scaled to the window.
- **1:1** — one remote pixel per screen pixel.
- **Zoom** — 25% to 200%, plus **monitor halves** (left/right/top/bottom)
  for wide multi-monitor hosts, which VNC sends as one wide screen.

When the remote screen is larger than the window, **hold the pointer at a
window edge to pan** in that direction. Clicks always land where you
point, at every zoom level.

### Keyboard

- **Capture keys** sends Super/Windows, Alt-Tab, and function keys to the
  remote machine instead of your own desktop.
- **Keyboard Shortcuts** has one-click shortcuts per remote OS and sticky
  modifiers (Ctrl, Alt, Shift, Super stay pressed until you click them
  again).

### Clipboard

Text you copy on either side is available on the other (toggle it in
**Session Settings**). Some servers — notably macOS Screen Sharing —
don't support clipboard sync at all.

### Touchscreens

Touchscreen laptops get the same gestures as the mobile app's Touch mode
(below). Click **Fit** to undo a pinch-zoom.

### This computer's Tailscale name

Settings → **This Computer** → **Tailscale Name** is the name other
devices see for this NomadVNC app on your tailnet. Leave it blank to use
NomadVNC plus the computer's name. Click **Save Name** to apply it.
That does not sign you in. If Tailscale is already connected, the name
updates then.

## Mobile (Android, iOS)

### Home

When you're signed in, the home screen leads with your computers. Tap
one to connect. Sign out stays on that card. The account server address
and deleting the account are in **Settings → Account**. A typed address
or a computer picked from your tailnet brings up **Connect** at the
bottom of the screen.

### This device's Tailscale name

Settings → **This Device** → **Tailscale Name**. Leave the field blank
to use NomadVNC plus the phone's name. iPhone used to appear as
NomadVNC-localhost because the phone reports its computer name as
localhost. Set a name such as `greg-iphone`, then tap **Save Name**.
That does not sign you in. If Tailscale is already connected, the name
updates then.

### Session toolbar

The bar above the desktop names the computer and has three controls:
keyboard, display options, and disconnect. Disconnect is the power
button, set apart from the others. The chevron on the left tucks the
bar away so the desktop can use the height; tap **Toolbar** at the top
of the screen to bring it back.

### Fitting the screen

**Fit**, the default, shows the whole remote screen, centered on the
phone. Pinch to zoom, then drag to move around. **Actual Size** is one
remote pixel per screen pixel. Both are under **Display**, and a saved
device remembers the choice.

### Touch and Trackpad modes

Choose under **Display → Pointer** during a session, or in **Settings →
Touch Input** (it's remembered).

- **Touch** — tap exactly where you want to click. Best on tablets and
  for large buttons.
- **Trackpad** — the screen works like a laptop trackpad: slide one finger
  to move the pointer, tap to click where it is. Best on phones and for
  small text.

### Gestures

| Gesture | Touch mode | Trackpad mode |
|---|---|---|
| Tap | Click where you tap | Click at the pointer |
| Slide one finger | Pan when zoomed in, otherwise move the pointer | Move the pointer |
| Two-finger tap | Right click | Right click |
| Three-finger tap | Middle click | Middle click |
| Long press | Right click | Right click |
| Long press, then drag | Click and drag | Click and drag |
| Tap, then touch and drag | Click and drag | Click and drag |
| Two-finger drag | Scroll | Scroll |
| Pinch | Zoom in and out | Zoom in and out |

Pinch-zoom only changes your view; the remote screen is untouched. Tap
the **Reset** chip (top right) to fit the whole screen again. The list is
also in the app under **Display → Gestures**.

A Bluetooth mouse, a trackpad, or an iPad keyboard with trackpad works
directly, like on a computer.

Switching away from the app for a moment keeps the session. If the phone
suspended it, NomadVNC reconnects on its own when you come back, on the
same screen.

### Keyboard

Tap **Keyboard** to open your phone's keyboard plus a bar of keys phones
don't have:

- **Ctrl, Alt, Shift, Win** — sticky: tap Ctrl, then type `c` for Ctrl+C.
  Tap again to release.
- **Esc, Tab, Del, arrows, Home/End, PgUp/PgDn, F1–F12, Ctrl+Alt+Del.**
- **Paste** — *types* your phone's clipboard into the remote machine.
  Use it where pasting doesn't work, such as login screens.
- **abc** — show or hide the phone keyboard while keeping the key bar.

Autocorrect and suggestions are off while you type into a session, so
what you type is exactly what the remote machine receives.

### Clipboard

With clipboard sync on (the Clipboard row under Display, or in Settings):

- **Remote → phone:** anything copied on the remote machine is copied to
  your phone.
- **Phone → remote:** on **Android**, something new you copy is sent
  automatically (Android shows a one-line "pasted from your clipboard"
  notice each time). On **iOS**, open **Display** and tap **Send
  Clipboard**. A dot on the Display button means the phone clipboard has
  something new. iOS asks permission whenever an app reads the clipboard,
  so NomadVNC only reads it when you tap.

NomadVNC never reads your clipboard just to check whether it changed.

### Display options

**Display** also has image **Quality** (Auto lowers it on slow
connections and sharpens the picture once you stop moving), **Scale**
(Fit Screen or Actual Size), and **Region** (monitor halves). Quality, scale, and
region are remembered per saved device.

## Slow or frozen sessions

NomadVNC checks every few seconds that the remote computer is still
answering. On desktop the badge next to the computer's name says
**Live**, **Slow** (with the reply time), or **Not Responding**. On a
phone a **Slow** chip appears at the top left of the screen.

After about seven seconds without a reply, a **Not Responding** card
says whether the network still reaches the computer. If it does, the
computer's VNC server is busy or asleep. If it doesn't, the network path
is down or the computer is off. Sessions dialed by address can't check
the network, so the card doesn't say which. If nothing answers for about 20 seconds,
NomadVNC drops the stuck connection and reconnects on its own.

To cycle the connection without waiting, use **Reconnect** in the
session toolbar (on a phone, the circular-arrow button). It works any
time, including while a session looks fine but feels stuck.
