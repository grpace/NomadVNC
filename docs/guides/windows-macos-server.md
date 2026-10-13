# VNC server setup on Windows and macOS

For headless **Linux** servers, see [linux-server.md](linux-server.md)
(one-command script) or the desktop app's **Settings → "Setting up a
headless server?"** guide. This page covers making a **Windows** or
**macOS** machine reachable from NomadVNC.

> NomadVNC Host is an optional Windows companion. macOS uses the built-in
> screen sharing. Any other computer can run a standard VNC server. On the
> same network, connect to that computer's address. From somewhere else,
> any VPN that can reach port 5900 works. Tailscale is one option, and
> NomadVNC can sign in to it for you.

## macOS (built-in — nothing to install)

1. System Settings → General → **Sharing** → turn on **Screen Sharing**.
2. Click the ⓘ next to Screen Sharing → **Computer Settings** →
   turn on **"VNC viewers may control screen with password"** and set a
   password (VNC uses the first 8 characters — make them random).
3. For remote access, install Tailscale on the Mac (Mac App Store, or the
   installer from [tailscale.com/download](https://tailscale.com/download))
   and sign in to the same tailnet as NomadVNC. For a Mac that's always
   on, disable its key expiry in the Tailscale admin console
   ([why](README.md#2-optional-reach-it-from-another-network)).
4. In NomadVNC, pick the Mac from your tailnet devices (or type its tailnet
   address, `100.x.y.z`) with port **5900** and the password from step 2.
   On the same local network you can skip Tailscale and use the Mac's LAN
   address instead.

Notes: macOS asks the logged-in user to allow each first connection unless
"Anyone may request permission" is configured. The Mac must stay awake —
set Energy Saver / Battery to prevent sleep (or allow "wake for network access").

## Windows (NomadVNC Host)

NomadVNC Host is an optional 64-bit Windows companion. The viewer does
not need it: TightVNC, or any other VNC server, works the same way. The
host shares that PC's screen on port 5900. This version does not include
SSH. Download `NomadVNC-Host-<version>-x64.exe` from
[Releases](https://github.com/grpace/NomadVNC/releases). It is not inside
the viewer installer. To build it yourself:

```bash
pnpm build:host
```

That writes `go-core/bin/nomadvnc-host.exe`.

1. Copy the exe to the PC and run it.
2. Approve the administrator prompt.
3. Enter a password of 8 characters or fewer and choose **Install and
   Start**. **Name** is only a label: the viewer shows it for this PC, and
   it is the PC's name on your tailnet if you sign in to Tailscale. It
   starts as the Windows computer name. **Port** is 5900, the usual VNC
   port; change it if something else on the PC uses that one, and connect
   to the port you chose.
4. Remote access is optional, and any VPN works. On the same network, skip
   this and connect to the PC's address. To use another VPN (WireGuard,
   OpenVPN, or anything else that can reach the PC), connect to the address
   that VPN gives it. To use Tailscale without installing the Tailscale app,
   choose **Sign In with Tailscale**. Sign in with the account that owns
   the tailnet. Setup stays on that step until you open this PC on the
   Machines page and choose **Disable Key Expiry**. Until you do, the PC
   drops off on the date Tailscale shows.

After setup it runs as a Windows service: it starts at boot, before
anyone signs in, with no window, and Windows restarts it if it stops.
Its saved password and Tailscale key are readable only by
administrators. If the Tailscale connection drops, the host reconnects
on its own; it can only stay on the tailnet long term once key expiry is
off for this PC (step 4). Open **NomadVNC Host** from
the Start menu to change the password, sign in to Tailscale, or uninstall.

In NomadVNC, connect to that PC on port **5900** with the password from
step 3. After a Tailscale sign-in, the PC appears on your tailnet under
the name from step 3. With another VPN, use the address that VPN assigns.

Other VNC viewers work too, such as RealVNC Viewer on a phone that runs
the Tailscale app. Connect to the PC's tailnet name or `100.x` address on
port 5900. If you used **Sign In with Tailscale**, that's the name from
step 3. If the PC runs the Tailscale app instead, use its name there.
RealVNC warns that the connection is not encrypted. The VNC connection
itself isn't, but Tailscale or your VPN encrypts everything between the
two devices, so it is safe to continue. Any picture-quality setting works.

The host compresses what it sends. NomadVNC viewers get Tight: photos
and video as JPEG at the viewer's quality setting, and text and flat
areas exact. **Lossless** sends everything exact. RealVNC gets ZRLE,
which is always exact. NomadVNC viewers also receive changes as they
happen rather than asking for each frame, which keeps a link with a long
round trip smooth.

Setup marks a Public network as Private so other computers on that network
can connect. It does not open the port on a network Windows still calls
Public, and it does not forward the port to the internet.

While the PC is locked or sitting at the Windows sign-in screen, the
connection shows that screen, and you can unlock it or sign in from the
viewer. The connection stays up as you do. Windows approval prompts ("Do
you want to allow this app to make changes?") show as well, and you can
answer them. The one thing a viewer can't send is Ctrl+Alt+Del, so a PC
set to require it before sign-in, as some work PCs are, can't be unlocked
this way.

The host keeps running after you close the window, and starts with the
PC. Its icon, a blue shield, sits in the system tray while someone is
signed in; Windows 11 keeps new icons under the **^** arrow until you
drag them onto the taskbar. Point at it to see whether the screen is
being shared and on which port, and click it to open the window again and
change the name, the port or the password.

Uninstall from the NomadVNC Host window, or from **Installed apps** in
Windows Settings. Either asks before deleting the saved password and
Tailscale sign-in.

## A fleet of Windows PCs

If you manage a fleet of computers, NomadVNC Host is the easy configuration
on each Windows PC. You run it once per machine. After that it starts at
every boot, before anyone signs in to Windows, with no window. Give each PC its own name so you can tell them apart.

On each PC, open an administrator command prompt and run the downloaded
exe. The command does not open the setup window:

```bat
start /wait "" NomadVNC-Host-<version>-x64.exe --install --name "front-desk" --password "8chars"
```

Add `--port 5901` to use a port other than 5900, and `--no-tray` to leave
the icon out of the system tray. `start /wait` makes the prompt wait until
it has finished, and leaves
`%ERRORLEVEL%` at 0 when it worked. `--name` is what you will see from
your other devices. Letters, numbers, and spaces are fine. `Front Desk`
is saved as `front-desk`. The password is 8 characters or fewer. When the
command prints that NomadVNC Host is installed and running, that PC is
done.

The password is on that command line, so other admins on the PC can see
it. To keep it off the command line, pipe it instead:

```bat
<nul set /p=8chars| NomadVNC-Host-<version>-x64.exe --install --name front-desk
```

Connect from NomadVNC on port **5900** with that password. On the same
network, use the PC's address and skip a VPN. From somewhere else, any
VPN that can reach the PC works. Connect to the address that VPN gives
it. Tailscale inside the host is optional, and it is not part of this
silent install. It needs someone at the PC to approve the browser login
and turn off key expiry. Skip it when the PCs are already on a network
you can reach.

To change the password or the name later, run the same `--install`
command again. The port stays as it was unless you pass `--port`. To move to a newer host exe, run that command with the
new file. It replaces the program and keeps starting at boot.

Each PC lists NomadVNC Host and its version under **Installed apps**, where
management tools read it. To check or remove it from a script:

```bat
"C:\Program Files\NomadVNC Host\nomadvnc-host.exe" --version
start /wait "" "C:\Program Files\NomadVNC Host\nomadvnc-host.exe" --uninstall
```

`--uninstall` keeps the saved password and Tailscale sign-in, so a later
install picks them up. Add `--delete-data` to remove those too.

To remove it without a window:

```bat
NomadVNC-Host-<version>-x64.exe --uninstall
```

That stops the service and removes the firewall rule. The saved password
stays until you also pass `--delete-data`.

Open **NomadVNC Host** from the Start menu when you want the setup window
instead of these commands.

## Windows (TightVNC)

1. Download **TightVNC** (tightvnc.com) and install it — check both the
   *Server* and *Viewer* components (viewer is optional).
2. Launch **TightVNC Service Configuration** → set the **Primary password**
   (8 characters maximum — make them random).
3. On the **Access Control** tab, make sure loopback/tailnet connections are
   allowed; restrict to your Tailscale interface if you want.
4. For remote access, install Tailscale on the PC
   ([tailscale.com/download](https://tailscale.com/download) or
   `winget install --id Tailscale.Tailscale -e`) and sign in to the same
   tailnet as NomadVNC. For a PC that's always on, disable its key expiry
   in the Tailscale admin console.
5. Allow port **5900** through the Windows firewall **only** from your
   tailnet (and/or your local network) — never from the whole internet.
   From an administrator PowerShell:
   ```powershell
   # tailnet only
   netsh advfirewall firewall add rule name="TightVNC (tailnet)" dir=in action=allow protocol=TCP localport=5900 remoteip=100.64.0.0/10
   # local network only
   netsh advfirewall firewall add rule name="TightVNC (LAN)" dir=in action=allow protocol=TCP localport=5900 remoteip=LocalSubnet
   ```
6. In NomadVNC, pick the PC from your tailnet devices (or type its tailnet
   or LAN address) with port **5900** and the TightVNC password.

Notes: on laptops, disable sleep-when-lid-closed if you want to reach a
headless docked machine. TightVNC's mirror driver is unnecessary on modern
Windows — skip it during install.

## Verifying any server

From another machine that can reach it (the local network, or any VPN):

```sh
# Linux/macOS: check the port answers
nc -vz 100.x.y.z 5900
```

If that connects, NomadVNC should too. If it doesn't, the VNC server isn't
running, the firewall is blocking it, or the machine is asleep.
