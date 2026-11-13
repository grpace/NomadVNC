package mobile

import (
	"fmt"
	"net"
	"net/netip"
	"strconv"
	"strings"

	"tailscale.com/net/netmon"
)

// InterfaceLister reports the device's network interfaces from the native
// side. Android 11+ denies apps the NETLINK_ROUTE socket, so Go's
// net.Interfaces fails there ("route ip+net: netlinkrib: permission
// denied") and tsnet cannot start. The Android module implements this
// with java.net.NetworkInterface, the same approach as Tailscale's own
// Android app.
//
// InterfacesAsString returns one line per interface:
//
//	name index mtu up broadcast loopback pointToPoint multicast | addr/prefix addr/prefix
//
// The five flags are "true" or "false".
type InterfaceLister interface {
	InterfacesAsString() string
}

// RegisterInterfaceLister makes netmon use the native interface list
// instead of net.Interfaces. Call it once, before the tailnet starts.
func RegisterInterfaceLister(lister InterfaceLister) {
	if lister == nil {
		return
	}
	netmon.RegisterInterfaceGetter(func() ([]netmon.Interface, error) {
		return parseInterfaces(lister.InterfacesAsString())
	})
}

func parseInterfaces(text string) ([]netmon.Interface, error) {
	var out []netmon.Interface
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		head, addrPart, _ := strings.Cut(line, "|")
		fields := strings.Fields(head)
		if len(fields) != 8 {
			return nil, fmt.Errorf("interface line %q: want 8 fields before '|', got %d", line, len(fields))
		}
		index, err := strconv.Atoi(fields[1])
		if err != nil {
			return nil, fmt.Errorf("interface %s: index: %w", fields[0], err)
		}
		mtu, err := strconv.Atoi(fields[2])
		if err != nil {
			return nil, fmt.Errorf("interface %s: mtu: %w", fields[0], err)
		}
		var flags net.Flags
		for i, flag := range []net.Flags{net.FlagUp, net.FlagBroadcast, net.FlagLoopback, net.FlagPointToPoint, net.FlagMulticast} {
			on, err := strconv.ParseBool(fields[3+i])
			if err != nil {
				return nil, fmt.Errorf("interface %s: flag %d: %w", fields[0], i, err)
			}
			if on {
				flags |= flag
			}
		}
		if flags&net.FlagUp != 0 {
			flags |= net.FlagRunning
		}
		addrs := []net.Addr{}
		for _, a := range strings.Fields(addrPart) {
			prefix, err := netip.ParsePrefix(stripZone(a))
			if err != nil {
				continue // skip an address we can't read rather than lose the interface
			}
			addrs = append(addrs, &net.IPNet{
				IP:   prefix.Addr().AsSlice(),
				Mask: net.CIDRMask(prefix.Bits(), prefix.Addr().BitLen()),
			})
		}
		out = append(out, netmon.Interface{
			Interface: &net.Interface{Index: index, MTU: mtu, Name: fields[0], Flags: flags},
			AltAddrs:  addrs,
		})
	}
	return out, nil
}

// stripZone drops an IPv6 scope ("fe80::1%wlan0/64" → "fe80::1/64");
// netip.ParsePrefix rejects zones.
func stripZone(s string) string {
	addr, bits, ok := strings.Cut(s, "/")
	if i := strings.IndexByte(addr, '%'); i >= 0 {
		addr = addr[:i]
	}
	if !ok {
		return addr
	}
	return addr + "/" + bits
}
