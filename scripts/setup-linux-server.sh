#!/usr/bin/env bash
#
# NomadVNC headless Linux server setup (X11 via TigerVNC).
#
# Prepares this machine to be reached from NomadVNC over your tailnet:
#   1. Installs Tailscale (official installer) and signs the machine in.
#   2. Installs TigerVNC and sets the VNC password (prompted, never logged).
#   3. Installs a systemd user service so display :1 (VNC port 5901) runs
#      at boot, then opens that port for tailnet traffic only.
#
# Supported: Fedora/RHEL (dnf), Ubuntu/Debian (apt), Arch (pacman),
# openSUSE (zypper). Run as a normal user with sudo access — do NOT run
# the whole script as root (the VNC password and systemd user service
# belong to your account).
#
# Usage:
#   ./setup-linux-server.sh [--display :1] [--geometry 1920x1080] [--authkey TSKEY-...]
#   ./setup-linux-server.sh --status [--display :1]
#   ./setup-linux-server.sh --repassword [--display :1]
#   ./setup-linux-server.sh --uninstall [--display :1]
#
set -euo pipefail

DISPLAY_NUM=":1"
GEOMETRY="1920x1080"
AUTHKEY=""
MODE="setup"

usage() {
  cat <<EOF
Usage: $0 [options]

Setup (default): install Tailscale + TigerVNC, set the VNC password,
enable the systemd user service, open the firewall (tailnet-only),
and print the pairing summary.

  --display :N        X display to serve (default :1, VNC port 5900+N)
  --geometry WxH      desktop size (default 1920x1080)
  --authkey TSKEY-... join the tailnet non-interactively (headless boxes)

Other modes:
  --status            check service, port, and tailnet (changes nothing)
  --repassword        reset the VNC password and restart the service
  --uninstall         disable and remove the service (keeps packages/data)
  -h, --help          show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --display) DISPLAY_NUM="${2:-}"; shift 2 ;;
    --geometry) GEOMETRY="${2:-}"; shift 2 ;;
    --authkey) AUTHKEY="${2:-}"; shift 2 ;;
    --status) MODE="status"; shift ;;
    --repassword) MODE="repassword"; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1 (see --help)" >&2; exit 1 ;;
  esac
done

if ! [[ "$DISPLAY_NUM" =~ ^:[0-9]+$ ]]; then
  echo "Invalid --display '$DISPLAY_NUM': expected e.g. :1" >&2
  exit 1
fi
if ! [[ "$GEOMETRY" =~ ^[0-9]+x[0-9]+$ ]]; then
  echo "Invalid --geometry '$GEOMETRY': expected e.g. 1920x1080" >&2
  exit 1
fi

if [ "$(id -u)" = "0" ]; then
  echo "Run as your normal user (with sudo), not as root." >&2
  exit 1
fi

PORT=$((5900 + ${DISPLAY_NUM#:}))
SERVICE="nomadvnc-vncserver@${DISPLAY_NUM#:}.service"
UNIT="$HOME/.config/systemd/user/nomadvnc-vncserver@.service"

have() { command -v "$1" >/dev/null 2>&1; }

tailnet_ip() { tailscale ip -4 2>/dev/null || true; }
tailnet_name() {
  tailscale status --self 2>/dev/null | awk '{print $2}' || hostname
}

port_listening() {
  if have ss; then
    ss -lnt 2>/dev/null | grep -q ":${PORT} "
  else
    (exec 3<>"/dev/tcp/127.0.0.1/${PORT}") 2>/dev/null
  fi
}

do_status() {
  local rc=0
  if systemctl --user is-active --quiet "$SERVICE"; then
    echo "service : active ($SERVICE)"
  else
    echo "service : NOT active ($SERVICE)"
    rc=1
  fi
  if port_listening; then
    echo "port    : listening on $PORT"
  else
    echo "port    : NOT listening on $PORT"
    rc=1
  fi
  local ip
  ip="$(tailnet_ip)"
  if [ -n "$ip" ]; then
    echo "tailnet : $ip ($(tailnet_name))"
  else
    echo "tailnet : NOT logged in (run: sudo tailscale up)"
    rc=1
  fi
  return $rc
}

if [ "$MODE" = "status" ]; then
  do_status
  exit $?
fi

if [ "$MODE" = "repassword" ]; then
  echo "==> Resetting the VNC password (typing is hidden, nothing is logged)"
  vncpasswd
  systemctl --user restart "$SERVICE"
  echo "Password updated and $SERVICE restarted."
  exit 0
fi

if [ "$MODE" = "uninstall" ]; then
  echo "==> Disabling $SERVICE"
  systemctl --user disable --now "$SERVICE" 2>/dev/null || true
  rm -f "$UNIT"
  systemctl --user daemon-reload
  echo "Service removed. Packages, VNC password, and tailnet login were kept."
  echo "To close the firewall port again, re-run your firewall command without --add."
  exit 0
fi

echo "==> Detecting package manager"
PM=""
if have dnf; then
  PM="dnf"
elif have apt-get; then
  PM="apt"
elif have pacman; then
  PM="pacman"
elif have zypper; then
  PM="zypper"
else
  echo "Need dnf, apt, pacman, or zypper; found none." >&2
  exit 1
fi
echo "    Using: $PM"

echo "==> Installing Tailscale"
if ! have tailscale; then
  curl -fsSL https://tailscale.com/install.sh | sh
else
  echo "    tailscale already installed"
fi

echo "==> Joining tailnet"
if tailscale status >/dev/null 2>&1; then
  echo "    already logged in"
elif [ -n "$AUTHKEY" ]; then
  sudo tailscale up --authkey="$AUTHKEY"
else
  echo "    opening interactive login (a browser step may be required)…"
  sudo tailscale up
fi

echo "==> Installing TigerVNC"
if have vncserver; then
  echo "    vncserver already installed — skipping"
elif [ "$PM" = "dnf" ]; then
  sudo dnf install -y tigervnc-server
elif [ "$PM" = "apt" ]; then
  sudo apt-get update
  sudo apt-get install -y tigervnc-standalone-server
elif [ "$PM" = "pacman" ]; then
  sudo pacman -S --needed --noconfirm tigervnc
else
  sudo zypper install -y tigervnc
fi

echo "==> Setting the VNC password (typing is hidden, nothing is logged)"
vncpasswd

echo "==> Installing systemd user service ($SERVICE)"
mkdir -p ~/.config/systemd/user
cat > "$UNIT" <<EOF
[Unit]
Description=TigerVNC server for NomadVNC (%i)
After=network-online.target
Wants=network-online.target

[Service]
Type=forking
ExecStart=/usr/bin/vncserver %i -geometry $GEOMETRY -localhost no
ExecStop=/usr/bin/vncserver -kill %i
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now "$SERVICE"
sudo loginctl enable-linger "$USER"

echo "==> Opening VNC port $PORT for tailnet traffic only"
# Tailscale hands out addresses in 100.64.0.0/10, so scoping the rule to
# that range (or to the tailscale0 interface) keeps the VNC port closed
# to the public internet and the local LAN.
if have firewall-cmd; then
  if sudo firewall-cmd --permanent \
      --add-rich-rule="rule family=\"ipv4\" source address=\"100.64.0.0/10\" port port=\"$PORT\" protocol=\"tcp\" accept"; then
    sudo firewall-cmd --reload
  else
    echo "    WARNING: scoped rule failed — falling back to an unscoped port open" >&2
    sudo firewall-cmd --add-port="$PORT/tcp" --permanent
    sudo firewall-cmd --reload
  fi
elif have ufw; then
  if ip link show tailscale0 >/dev/null 2>&1; then
    sudo ufw allow in on tailscale0 to any port "$PORT" proto tcp
  else
    echo "    WARNING: no tailscale0 interface yet — opening $PORT/tcp broadly; re-run after 'sudo tailscale up' for a scoped rule" >&2
    sudo ufw allow "$PORT/tcp"
  fi
else
  echo "    no firewall-cmd/ufw found — open TCP $PORT for 100.64.0.0/10 yourself if a firewall is active"
fi

echo ""
echo "==> Verifying"
do_status || {
  echo "" >&2
  echo "Setup finished with warnings — see the NOT lines above." >&2
  exit 1
}

echo ""
echo "Done. Pair this machine from NomadVNC:"
echo "  device : $(tailnet_name) ($(tailnet_ip))"
echo "  port   : $PORT  (display $DISPLAY_NUM)"
echo "Refresh devices in NomadVNC, pick the server above, keep port $PORT, and connect."
