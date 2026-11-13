package mobile

import (
	"net"
	"testing"
)

func TestParseInterfaces(t *testing.T) {
	text := "lo 1 65536 true false true false false | 127.0.0.1/8 ::1/128\n" +
		"wlan0 30 1500 true true false false true | 192.168.1.23/24 fe80::1c2b:3cff:fe4d:5e6f%wlan0/64\n" +
		"rmnet_data0 12 1400 true false false true false |\n" +
		"\n"
	ifs, err := parseInterfaces(text)
	if err != nil {
		t.Fatal(err)
	}
	if len(ifs) != 3 {
		t.Fatalf("got %d interfaces, want 3", len(ifs))
	}
	wlan := ifs[1]
	if wlan.Name != "wlan0" || wlan.Index != 30 || wlan.MTU != 1500 {
		t.Fatalf("wlan0 parsed as %+v", wlan.Interface)
	}
	if !wlan.IsUp() || wlan.IsLoopback() || wlan.Flags&net.FlagMulticast == 0 {
		t.Fatalf("wlan0 flags = %v", wlan.Flags)
	}
	addrs, _ := wlan.Addrs()
	if len(addrs) != 2 || addrs[0].String() != "192.168.1.23/24" || addrs[1].String() != "fe80::1c2b:3cff:fe4d:5e6f/64" {
		t.Fatalf("wlan0 addrs = %v", addrs)
	}
	if !ifs[0].IsLoopback() {
		t.Fatal("lo should be loopback")
	}
	if a, _ := ifs[2].Addrs(); a == nil || len(a) != 0 {
		t.Fatalf("rmnet_data0 addrs = %#v, want empty non-nil", a)
	}
}

func TestParseInterfacesRejectsMalformed(t *testing.T) {
	if _, err := parseInterfaces("wlan0 x 1500 true true false false true |"); err == nil {
		t.Fatal("want error for a non-numeric index")
	}
}
