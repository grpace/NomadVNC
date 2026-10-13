package hostnet

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestHostnameShape(t *testing.T) {
	name := Hostname()
	if !strings.HasPrefix(name, "nomadvnc-host-") {
		t.Fatalf("hostname %q", name)
	}
	if len(name) > 63 {
		t.Fatalf("hostname length %d", len(name))
	}
	for _, r := range name {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '-' {
			t.Fatalf("hostname %q has %q", name, r)
		}
	}
}

func TestHasIdentityMissing(t *testing.T) {
	dir := t.TempDir()
	if HasIdentity(dir) {
		t.Fatal("empty directory reported a tailnet identity")
	}
	if err := os.WriteFile(filepath.Join(dir, "tailscaled.state"), []byte("pending"), 0o644); err != nil {
		t.Fatal(err)
	}
	if HasIdentity(dir) {
		t.Fatal("a pending state file was treated as a finished sign-in")
	}
}

func TestKeyExpiryStatusStaysUnfinishedUntilOff(t *testing.T) {
	pending := keyExpiryPendingStatus(time.Date(2026, time.October, 5, 0, 0, 0, 0, time.UTC))
	if !strings.Contains(pending, "not finished") {
		t.Fatalf("pending status = %q", pending)
	}
	if !strings.Contains(pending, "Disable Key Expiry") || !strings.Contains(pending, "owns the tailnet") {
		t.Fatalf("pending status = %q", pending)
	}
	if !strings.Contains(pending, "5 October 2026") {
		t.Fatalf("pending status = %q", pending)
	}
	off := keyExpiryOffStatus()
	if strings.Contains(off, "not finished") || !strings.Contains(off, "stays available") {
		t.Fatalf("off status = %q", off)
	}
}

func TestDeviceHostnameUsesChosenName(t *testing.T) {
	if got := DeviceHostname("bay-1"); got != "bay-1" {
		t.Fatalf("hostname = %q", got)
	}
	if got := DeviceHostname("  "); !strings.HasPrefix(got, "nomadvnc-host-") {
		t.Fatalf("default hostname = %q", got)
	}
}

func TestStatusFileRoundTrips(t *testing.T) {
	dir := t.TempDir()
	if _, err := ReadStatus(dir); err == nil {
		t.Fatal("read a status that was never written")
	}
	want := Status{State: "Running", KeyExpiry: time.Date(2027, 1, 2, 0, 0, 0, 0, time.UTC), Updated: time.Now().UTC().Round(time.Second)}
	writeStatus(dir, want)
	got, err := ReadStatus(dir)
	if err != nil || got.State != want.State || !got.KeyExpiry.Equal(want.KeyExpiry) || !got.Updated.Equal(want.Updated) {
		t.Fatalf("status = %+v, %v; want %+v", got, err, want)
	}
}

func TestWaitForKeyExpiryOffFollowsTheService(t *testing.T) {
	dir := t.TempDir()
	var opened []string
	var statuses []string
	done := make(chan struct{})
	go func() {
		WaitForKeyExpiryOff(t.Context(), dir, time.Now().Add(24*time.Hour),
			func(u string) { opened = append(opened, u) },
			func(s string) { statuses = append(statuses, s) })
		close(done)
	}()
	time.Sleep(100 * time.Millisecond)
	writeStatus(dir, Status{State: "Running", Updated: time.Now()})
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("kept waiting after the service reported key expiry off")
	}
	if len(opened) != 1 || opened[0] != tailscaleMachinesURL {
		t.Fatalf("opened %v", opened)
	}
	if last := statuses[len(statuses)-1]; last != keyExpiryOffStatus() {
		t.Fatalf("last status %q", last)
	}
}
