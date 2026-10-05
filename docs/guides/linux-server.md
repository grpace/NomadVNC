# Linux server setup

Get a headless Fedora/RHEL, Ubuntu/Debian, Arch, or openSUSE box reachable
from NomadVNC in about a minute. Serves an X11 desktop via TigerVNC. No
Nomad account needed — everything stays between your devices and your
tailnet. (Windows or macOS machine? See
[windows-macos-server.md](windows-macos-server.md).)

## Option A — one command (recommended)

On the server, as your normal user (with sudo — never as root):

```bash
curl -fsSLO https://raw.githubusercontent.com/grpace/NomadVNC/master/scripts/setup-linux-server.sh
chmod +x setup-linux-server.sh
./setup-linux-server.sh
```

Useful flags: `--display :2` (a second desktop), `--geometry 2560x1440`,
`--authkey TSKEY-...` (skip the browser login on truly headless boxes).

The script installs Tailscale + TigerVNC (skipping what is already there),
sets the VNC password (interactive, never logged), enables a systemd user
service for the desktop, opens the firewall for tailnet traffic only, then
verifies the service, port, and tailnet login and prints the device + port
to pick in NomadVNC.

Day-to-day management with the same script:

```bash
./setup-linux-server.sh --status      # check service, port, tailnet (changes nothing)
./setup-linux-server.sh --repassword  # reset the VNC password and restart the desktop
./setup-linux-server.sh --uninstall   # disable and remove the service (keeps packages/data)
```

## Option B — by hand (or to understand what the script does)

The same steps live in the desktop app: **Settings → "Setting up a headless
server?"** — each step has a copy button.
In short:

1. `curl -fsSL https://tailscale.com/install.sh | sh` then `sudo tailscale up`.
2. Install `tigervnc-server` (dnf) or `tigervnc-standalone-server` (apt),
   then `vncpasswd`.
3. Enable the `nomadvnc-vncserver@:1` systemd user service from the guide
   (display `:1` = VNC port **5901**), plus `loginctl enable-linger`.
4. Open TCP 5901 (`firewall-cmd` / `ufw`), then refresh devices in NomadVNC
   and save the machine with port 5901.

Only using it on your local network? Skip Tailscale, open the port to your
LAN instead, and add the machine in NomadVNC by its LAN address.

## Notes

- The VNC server listens beyond loopback (`-localhost no`) because NomadVNC
  arrives over the tailnet interface. The script and the in-app guide scope
  the firewall to tailnet traffic only (firewalld rich rule for
  `100.64.0.0/10`, `ufw allow in on tailscale0`): leave the port closed on
  public interfaces and consider Tailscale ACLs / subnet scoping on top.
- TigerVNC supports RandR resizing, so the viewer's resize-host toggle works.
- Wayland sessions: TigerVNC serves X11. For a Wayland desktop, either run
  an X11 session on the server or use GNOME's built-in remote desktop
  (`gnome-remote-desktop`) instead of TigerVNC — NomadVNC connects to any
  VNC server on the tailnet either way.

## Sharing the desktop you're already using

The script above starts a *separate* desktop for remote use — the right
choice for servers. To see and control the screen someone is already
logged in to, use your desktop's own sharing instead (port **5900**):

- **KDE Plasma — Krfb ("Desktop Sharing").** Install `krfb`
  (`sudo dnf install krfb` / `sudo apt install krfb`), open **Desktop
  Sharing**, enable it and set a password. On Wayland, Plasma asks the
  local user to approve screen sharing and remote control; Plasma 6.5 and
  newer can remember that grant so later connections don't prompt.
- **GNOME — GNOME Remote Desktop.** The Remote Desktop page in Settings
  speaks RDP, which NomadVNC doesn't use, but the same service has a VNC
  mode you can turn on from a terminal on distributions that build it in:
  ```bash
  grdctl vnc enable
  grdctl vnc set-auth-method password
  grdctl vnc set-password 'your8chr'      # VNC uses the first 8 characters
  grdctl vnc disable-view-only            # allow control, not just viewing
  ```
  Then turn on **Settings → System → Remote Desktop → Desktop Sharing**
  (or log out and back in). If `grdctl vnc` reports it isn't supported,
  your distribution ships GNOME Remote Desktop without VNC — use the
  script's separate desktop instead.
- **Sway, Hyprland and other wlroots compositors — WayVNC.** Install
  `wayvnc` and run it inside your session; see its README for password
  setup.
- **X11 desktops (XFCE, MATE, Cinnamon, or GNOME/KDE on X11) — x11vnc.**
  `x11vnc -storepasswd` once, then `x11vnc -usepw -display :0 -forever`.

Open port 5900 to your tailnet (or LAN) the same way the script does for
5901, and if you use Tailscale, disable key expiry for always-on machines
([guide](README.md#2-optional-reach-it-from-another-network)).

## Running the client itself headless

If you launch the NomadVNC desktop client on a box with no browser (a jump
host, an automated setup), the usual interactive Tailscale login can't open.
Give the sidecar an auth key instead — either as an environment variable when
starting the app, or as a flag when invoking the sidecar directly:

```bash
NOMADVNC_AUTHKEY=tskey-auth-... nomadvnc
# or: nomadvnc-sidecar --authkey tskey-auth-...
```

The flag wins when both are set. With a key configured, the sidecar logs in
non-interactively; if the key is rejected it reports the state instead of
hanging on a browser prompt. Generate a reusable, non-expiring key in the
Tailscale admin console (Keys → Auth keys), and prefer tagging it so it can
only join as this client. Interactive login remains the default whenever no
key is configured.

In auth-key mode the UI's re-authenticate action can't open a browser, so it
explains the limitation instead: rotate the key in the admin console, update
`NOMADVNC_AUTHKEY` (or `--authkey`), and restart the app.
