package engine

import (
	"context"
	"net/netip"
	"strings"
	"time"

	"github.com/nomadvnc/nomadvnc/go-core/internal/session"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tailcfg"
)

// pingTimeout bounds the best-effort disco ping used for latency. Path
// classification never depends on the ping — status data is the fallback.
const pingTimeout = 4 * time.Second

// GetPeerPath reports how tailnet traffic reaches host: a direct UDP path,
// a DERP-relayed path, or unknown. host may be a tailnet IP, MagicDNS name,
// or short hostname. It never fails when the peer is simply absent — that
// comes back as Found=false — so the UI can distinguish "offline" from
// "sidecar broken".
func (e *Engine) GetPeerPath(ctx context.Context, host string) (session.PeerPath, error) {
	lc, err := e.ensureServer()
	if err != nil {
		return session.PeerPath{}, err
	}

	status, err := lc.Status(ctx)
	if err != nil {
		return session.PeerPath{}, err
	}

	peer := matchPeerStatus(status, host)
	if peer == nil {
		return session.PeerPath{Host: host, Found: false, Path: "unknown"}, nil
	}

	path := classifyPeerPath(peer, nil)

	if addr := peerPingAddr(peer, host); addr.IsValid() {
		pingCtx, cancel := context.WithTimeout(ctx, pingTimeout)
		defer cancel()
		if ping, pingErr := lc.Ping(pingCtx, addr, tailcfg.PingDisco); pingErr == nil && ping != nil && ping.Err == "" {
			path = classifyPeerPath(peer, ping)
		}
	}

	path.Host = host
	return path, nil
}

// matchPeerStatus finds the status entry for host across IPs, FQDN, and
// short hostname. DNS comparison is case-insensitive and dot-insensitive.
func matchPeerStatus(status *ipnstate.Status, host string) *ipnstate.PeerStatus {
	if status == nil {
		return nil
	}
	needle := strings.ToLower(strings.TrimSuffix(strings.TrimSpace(host), "."))
	if needle == "" {
		return nil
	}
	for _, peer := range status.Peer {
		if peer == nil {
			continue
		}
		if strings.ToLower(strings.TrimSuffix(peer.DNSName, ".")) == needle {
			return peer
		}
		if strings.ToLower(peer.HostName) == needle {
			return peer
		}
		for _, ip := range peer.TailscaleIPs {
			if strings.ToLower(ip.String()) == needle {
				return peer
			}
		}
	}
	return nil
}

// peerPingAddr prefers a literal IP host, falling back to the peer's first
// tailnet IP so MagicDNS/hostname lookups still get a latency sample.
func peerPingAddr(peer *ipnstate.PeerStatus, host string) netip.Addr {
	if addr, err := netip.ParseAddr(strings.TrimSpace(host)); err == nil {
		return addr
	}
	if len(peer.TailscaleIPs) > 0 {
		return peer.TailscaleIPs[0]
	}
	return netip.Addr{}
}

// classifyPeerPath reduces status + (optional) disco ping to the UI verdict.
// A successful ping wins; status fields (Relay/CurAddr) are the fallback.
func classifyPeerPath(peer *ipnstate.PeerStatus, ping *ipnstate.PingResult) session.PeerPath {
	out := session.PeerPath{Found: true, Path: "unknown"}

	if ping != nil {
		if ping.DERPRegionID != 0 || ping.DERPRegionCode != "" {
			out.Path = "relay"
			out.RelayRegion = ping.DERPRegionCode
		} else if ping.Endpoint != "" || ping.LatencySeconds > 0 {
			out.Path = "direct"
			out.Endpoint = ping.Endpoint
		}
		if ping.LatencySeconds > 0 {
			ms := int64(ping.LatencySeconds * 1000)
			out.LatencyMs = &ms
		}
		if out.Path != "unknown" {
			return out
		}
	}

	if peer != nil {
		if peer.Relay != "" {
			out.Path = "relay"
			out.RelayRegion = peer.Relay
		} else if peer.CurAddr != "" {
			out.Path = "direct"
			out.Endpoint = peer.CurAddr
		}
	}
	return out
}
