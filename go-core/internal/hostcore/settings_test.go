package hostcore

import "testing"

func TestParsePort(t *testing.T) {
	for raw, want := range map[string]int{"": 5900, "  ": 5900, "5900": 5900, " 5901 ": 5901, "1": 1, "65535": 65535} {
		got, err := ParsePort(raw)
		if err != nil || got != want {
			t.Errorf("ParsePort(%q) = %d, %v; want %d", raw, got, err, want)
		}
	}
	for _, raw := range []string{"0", "65536", "-1", "vnc", "59 00", "5900.5", "5910"} {
		if port, err := ParsePort(raw); err == nil {
			t.Errorf("ParsePort(%q) = %d, want an error", raw, port)
		}
	}
}

func TestListenAddr(t *testing.T) {
	if got := ListenAddr(5901); got != ":5901" {
		t.Errorf("ListenAddr = %q", got)
	}
}
