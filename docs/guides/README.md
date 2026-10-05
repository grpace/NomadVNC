# Set up a computer to connect to

NomadVNC is the *viewer*. The computer you want to control needs two
things:

1. **A VNC server**, the part that shares its screen.
2. **A way to reach it**, only if you are not on the same network. Any VPN
   works. Tailscale is the one NomadVNC can sign in to for you.

## 1. Turn on a VNC server

| Computer | What to use | Guide |
|---|---|---|
| **Mac** | Built-in Screen Sharing, nothing to install | [windows-macos-server.md](windows-macos-server.md#macos-built-in--nothing-to-install) |
| **Windows** | Optional NomadVNC Host, or TightVNC. A fleet of PCs can use the [silent install](windows-macos-server.md#a-fleet-of-windows-pcs). | [windows-macos-server.md](windows-macos-server.md#windows-nomadvnc-host) |
| **Linux server / headless box** | TigerVNC, set up by one script | [linux-server.md](linux-server.md) |
| **Linux desktop** (share the screen you're using) | Krfb (KDE), GNOME Remote Desktop, WayVNC (Sway/Hyprland), x11vnc (X11) | [linux-server.md](linux-server.md#sharing-the-desktop-youre-already-using) |

The desktop app has the Linux and Windows guides built in, with copy
buttons: **Settings → "Setting up a headless server?"** and **"Setting up
a Windows PC?"**.

**About VNC passwords:** standard VNC authentication only uses the
**first 8 characters** of the password, and on a local network the
session itself isn't encrypted. Use 8 random characters, never forward
the VNC port to the internet, and use a VPN for anything beyond a trusted
home or office network.

## 2. Optional: reach it from another network

Any VPN that puts your phone and the computer on a network where port
5900 is reachable works the same way. Connect to the address that VPN
gives the computer. The local network needs no VPN.

[Tailscale](https://tailscale.com) is one such VPN: a private network (a
*tailnet*) with encrypted WireGuard links, and no port forwarding.
NomadVNC has Tailscale built in, on the viewer and, optionally, inside
NomadVNC Host. You can also install the normal Tailscale app on the
computer you connect to. WireGuard, OpenVPN, and other VPN clients work
too. NomadVNC does not configure those for you.

If you choose Tailscale:

1. **Install Tailscale on the remote computer** and sign in:
   - **Mac:** the Mac App Store, or the installer from
     [tailscale.com/download](https://tailscale.com/download).
   - **Windows:** the installer from
     [tailscale.com/download](https://tailscale.com/download), or
     `winget install --id Tailscale.Tailscale -e`.
   - **Linux:** `curl -fsSL https://tailscale.com/install.sh | sh` then
     `sudo tailscale up` (the [Linux script](linux-server.md) does this
     for you).
2. **Sign in to the same tailnet** in NomadVNC: **Sign In with Tailscale**
   in the app, using the same account (or an account in the same
   organisation). A machine on someone else's tailnet can be
   [shared to you](https://tailscale.com/kb/1084/sharing) by its owner.
3. **For always-on computers, disable key expiry.** Tailscale devices
   must re-authenticate periodically (180 days by default). Sign in to the
   [admin console](https://login.tailscale.com/admin/machines) with the
   account that owns the tailnet, open the machine's **⋯** menu, and
   choose **Disable key expiry**, so a server doesn't drop off. NomadVNC
   Host stays on this step until the PC reports that key expiry is off.
4. **Optional:** use [ACLs](https://tailscale.com/kb/1018/acls) to allow
   only your own devices to reach port 5900/5901.

Each machine gets a stable address (`100.x.y.z`) and a name
(`office-pc`, or `office-pc.<your-tailnet>.ts.net` with
[MagicDNS](https://tailscale.com/kb/1081/magicdns)).

## 3. Add it in NomadVNC

- **On the same network, or through any other VPN:** **+ New** → type the
  computer's address (for example `192.168.1.20`, or the address that VPN
  assigned) → port → password → **Save Machine**.
- **Through Tailscale:** after signing in, pick the computer from
  **Tailnet Device** (no address needed), then port and password.

Ports: macOS and Windows use **5900**. The Linux script's first desktop
is **5901** (display `:1`), the next `:2` is 5902, and so on.

Once connected, see [Using NomadVNC](using-nomadvnc.md) for zooming,
touch gestures, the keyboard, and the clipboard.

## Troubleshooting

| What you see | Check |
|---|---|
| "Couldn't Connect" | VNC server running? Right port? Firewall allows it from where you are? Computer awake? |
| "rejected the password" | Remember only the first 8 characters count. On macOS, set the VNC password under Screen Sharing → Computer Settings. |
| The machine shows offline in the tailnet list | Tailscale running and signed in on it? Key expired? (See step 2.3.) |
| Connected, but a black or frozen screen | Linux: the session may be locked or on Wayland without a portal grant. See [linux-server.md](linux-server.md#sharing-the-desktop-youre-already-using). |
| macOS asks for a username | Enter your Mac account's short name under **Add macOS Username** on the machine. |

Still stuck? Check that the port answers from another device on the same
network or tailnet: `nc -vz <address> 5900`.
