package engine

import (
	"net/netip"
	"testing"

	"tailscale.com/ipn/ipnstate"
	"tailscale.com/types/key"
)

func testPeer() *ipnstate.PeerStatus {
	return &ipnstate.PeerStatus{
		HostName:     "lab",
		DNSName:      "lab.tail12345.ts.net.",
		TailscaleIPs: []netip.Addr{netip.MustParseAddr("100.64.0.10")},
		CurAddr:      "192.0.2.1:41641",
	}
}

func TestMatchPeerStatus(t *testing.T) {
	status := &ipnstate.Status{
		Peer: map[key.NodePublic]*ipnstate.PeerStatus{
			{}: testPeer(),
		},
	}

	for _, host := range []string{
		"100.64.0.10",
		"lab.tail12345.ts.net",
		"lab.tail12345.ts.net.",
		"LAB.TAIL12345.TS.NET",
		"lab",
	} {
		if got := matchPeerStatus(status, host); got == nil {
			t.Errorf("matchPeerStatus(%q) = nil, want peer", host)
		}
	}

	if got := matchPeerStatus(status, "unknown.tail.ts.net"); got != nil {
		t.Errorf("matchPeerStatus(unknown) = %+v, want nil", got)
	}
	if got := matchPeerStatus(nil, "lab"); got != nil {
		t.Errorf("matchPeerStatus(nil status) = %+v, want nil", got)
	}
	if got := matchPeerStatus(status, "  "); got != nil {
		t.Errorf("matchPeerStatus(blank) = %+v, want nil", got)
	}
}

func TestClassifyPeerPath(t *testing.T) {
	peer := testPeer()

	direct := classifyPeerPath(peer, &ipnstate.PingResult{LatencySeconds: 0.032, Endpoint: "192.0.2.1:41641"})
	if direct.Path != "direct" || direct.LatencyMs == nil || *direct.LatencyMs != 32 {
		t.Errorf("direct ping = %+v, want path=direct latencyMs=32", direct)
	}
	if direct.Endpoint != "192.0.2.1:41641" {
		t.Errorf("direct endpoint = %q, want dial endpoint", direct.Endpoint)
	}

	relayed := classifyPeerPath(peer, &ipnstate.PingResult{LatencySeconds: 0.24, DERPRegionID: 7, DERPRegionCode: "sea"})
	if relayed.Path != "relay" || relayed.RelayRegion != "sea" {
		t.Errorf("relay ping = %+v, want path=relay region=sea", relayed)
	}
	if relayed.LatencyMs == nil || *relayed.LatencyMs != 240 {
		t.Errorf("relay latency = %+v, want 240ms", relayed.LatencyMs)
	}

	statusOnly := classifyPeerPath(peer, nil)
	if statusOnly.Path != "direct" || statusOnly.Endpoint != peer.CurAddr || statusOnly.LatencyMs != nil {
		t.Errorf("status fallback = %+v, want direct via CurAddr without latency", statusOnly)
	}

	relayStatus := classifyPeerPath(&ipnstate.PeerStatus{Relay: "fra"}, nil)
	if relayStatus.Path != "relay" || relayStatus.RelayRegion != "fra" {
		t.Errorf("relay status = %+v, want path=relay region=fra", relayStatus)
	}

	unknown := classifyPeerPath(&ipnstate.PeerStatus{}, nil)
	if unknown.Path != "unknown" || !unknown.Found {
		t.Errorf("empty status = %+v, want found with unknown path", unknown)
	}

	// A ping without usable fields falls back to status data.
	degraded := classifyPeerPath(peer, &ipnstate.PingResult{})
	if degraded.Path != "direct" || degraded.Endpoint != peer.CurAddr {
		t.Errorf("degraded ping = %+v, want status fallback", degraded)
	}
}
