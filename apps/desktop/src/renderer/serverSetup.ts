export interface ServerSetupBlock {
  id: string;
  title: string;
  body: string;
  commands: string[];
}

function join(lines: string[]): string {
  return lines.join("\n");
}

/**
 * Copy-paste essentials for bringing a headless Linux box into NomadVNC.
 * The full automation lives in `scripts/setup-linux-server.sh` (canonical);
 * these blocks are the cheat-sheet rendered in the app. Display `:1` maps
 * to VNC port 5901 — the picker default the app suggests.
 */
export const SERVER_SETUP_BLOCKS: ServerSetupBlock[] = [
  {
    id: "one-command",
    title: "0. One command (recommended)",
    body: "Downloads the setup script and runs it as your normal user (with sudo). It installs Tailscale + TigerVNC, sets the VNC password, enables the desktop service at boot, opens the firewall for tailnet traffic only, and prints the pairing summary. Validates with ./setup-linux-server.sh --status afterwards.",
    commands: [
      "curl -fsSLO https://raw.githubusercontent.com/grpace/NomadVNC/master/scripts/setup-linux-server.sh",
      "chmod +x setup-linux-server.sh",
      "./setup-linux-server.sh",
    ],
  },
  {
    id: "tailscale",
    title: "1. Join the server to your tailnet",
    body: "Install Tailscale with the official installer, then sign the machine in. Headless boxes can paste an auth key instead of opening a browser.",
    commands: [
      "curl -fsSL https://tailscale.com/install.sh | sh",
      "sudo tailscale up",
    ],
  },
  {
    id: "vnc-server",
    title: "2. Install TigerVNC and set a password",
    body: "TigerVNC is the best-supported server for NomadVNC (RandR resizing included). Set a strong, unique VNC password when prompted.",
    commands: [
      "# Fedora / RHEL",
      "sudo dnf install -y tigervnc-server",
      "",
      "# Ubuntu / Debian",
      "sudo apt install -y tigervnc-standalone-server",
      "",
      "vncpasswd",
    ],
  },
  {
    id: "autostart",
    title: "3. Run the desktop at boot",
    body: "Display :1 serves VNC port 5901. It must listen beyond loopback because NomadVNC arrives over the tailnet interface. Keep it tailnet-only with your firewall or Tailscale ACLs.",
    commands: [
      "mkdir -p ~/.config/systemd/user",
      "cat > ~/.config/systemd/user/nomadvnc-vncserver@.service <<'EOF'",
      "[Unit]",
      "Description=TigerVNC server for NomadVNC (%i)",
      "After=network-online.target",
      "",
      "[Service]",
      "Type=forking",
      "ExecStart=/usr/bin/vncserver %i -geometry 1920x1080 -localhost no",
      "ExecStop=/usr/bin/vncserver -kill %i",
      "Restart=on-failure",
      "",
      "[Install]",
      "WantedBy=default.target",
      "EOF",
      "systemctl --user daemon-reload",
      "systemctl --user enable --now nomadvnc-vncserver@:1.service",
      "sudo loginctl enable-linger $USER",
    ],
  },
  {
    id: "firewall-pair",
    title: "4. Open the port (tailnet-only) and pair in NomadVNC",
    body: "Allow 5901 for tailnet traffic only, never the open internet. Then come back here: refresh devices, pick the server, keep port 5901, and save.",
    commands: [
      "# Fedora / RHEL (scoped to the 100.64.0.0/10 tailnet range)",
      "sudo firewall-cmd --permanent --add-rich-rule='rule family=\"ipv4\" source address=\"100.64.0.0/10\" port port=\"5901\" protocol=\"tcp\" accept' && sudo firewall-cmd --reload",
      "",
      "# Ubuntu / Debian (scoped to the tailscale0 interface)",
      "sudo ufw allow in on tailscale0 to any port 5901 proto tcp",
    ],
  },
];

export function buildCopyText(block: ServerSetupBlock): string {
  return join(block.commands);
}

/**
 * Optional Windows companion (NomadVNC Host) plus any way to reach the PC.
 * Rendered in the desktop Settings panel next to the headless Linux guide;
 * mobile ships its own touch-sized version.
 */
export const WINDOWS_PC_SETUP_BLOCKS: ServerSetupBlock[] = [
  {
    id: "host",
    title: "1. Install NomadVNC Host",
    body: "Optional. On the Windows PC, run NomadVNC-Host from Releases, or nomadvnc-host.exe, and approve the administrator prompt. Set the name you want to see on your other devices, set a password of 8 characters or fewer, and choose Install and Start. It shares the screen on port 5900, including the Windows sign-in screen, and starts at boot with no window. If you manage a fleet of computers, the setup guide has a silent install that does not open a window. TightVNC, or any other VNC server, still works if you already use it.",
    commands: [],
  },
  {
    id: "tailscale",
    title: "2. Reach the PC",
    body: "On the same network, skip this and use the PC's address. Any VPN works: connect to the address that VPN gives the PC. Tailscale is optional. In NomadVNC Host, choose Sign In with Tailscale to join a tailnet without installing the Tailscale app. Sign in with the account that owns the tailnet. Setup stays on that step until you choose Disable Key Expiry for this PC on the Tailscale Machines page.",
    commands: [],
  },
  {
    id: "save-device",
    title: "3. Save the PC in NomadVNC",
    body: "In NomadVNC, choose + New. After a Tailscale sign-in, pick the PC from Tailnet Device. On the local network, or through any other VPN, type its address. Use port 5900 and save the VNC password.",
    commands: [],
  },
  {
    id: "connect",
    title: "4. Connect",
    body: "Click Connect on the machine card. While the PC is locked, you see the Windows sign-in screen. Someone else needs it too? With a Nomad account, use Share on the card.",
    commands: [],
  },
];

export function describeSetupCommand(): string {
  return join(SERVER_SETUP_BLOCKS.flatMap((block) => [`# ${block.title}`, ...block.commands, ""]));
}
