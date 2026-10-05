package hostnet

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/tsnet"
)

// ErrNoIdentity means the user has not signed in, so the node must not start.
var ErrNoIdentity = errors.New("tailscale is not signed in")

// signedInMarker is written only after Tailscale reports the node is
// logged in. The state file appears earlier, while login is still pending,
// and must not cause the service to contact Tailscale on later boots.
const signedInMarker = "signed-in"

// HasIdentity reports whether sign-in finished and the node key should
// come back at boot.
func HasIdentity(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, signedInMarker))
	return err == nil
}

// DeviceHostname is the tailnet name for this PC. configured is a name
// the person chose; empty falls back to the Windows computer name.
func DeviceHostname(configured string) string {
	if strings.TrimSpace(configured) != "" {
		return strings.TrimSpace(configured)
	}
	return Hostname()
}

// Hostname is the tailnet device name used when no name was chosen.
func Hostname() string {
	raw, err := os.Hostname()
	if err != nil {
		raw = "pc"
	}
	var b strings.Builder
	lastSep := true
	for _, r := range strings.ToLower(strings.TrimSpace(raw)) {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			lastSep = false
			continue
		}
		if !lastSep {
			b.WriteByte('-')
			lastSep = true
		}
	}
	suffix := strings.Trim(b.String(), "-")
	if suffix == "" {
		suffix = "pc"
	}
	const prefix = "nomadvnc-host-"
	maxSuffix := 63 - len(prefix)
	if len(suffix) > maxSuffix {
		suffix = strings.Trim(suffix[:maxSuffix], "-")
	}
	return prefix + suffix
}

func newServer(dir, hostname string) *tsnet.Server {
	server := &tsnet.Server{
		Hostname:   hostname,
		Dir:        dir,
		AuthKey:    os.Getenv("NOMADVNC_AUTHKEY"),
		ControlURL: os.Getenv("NOMADVNC_TS_CONTROL_URL"),
	}
	// tsnet otherwise prints the interactive login URL on the process
	// stderr. Keep that address out of logs; the caller receives it
	// through the open callback.
	server.Logf = func(format string, args ...any) {
		text := fmt.Sprintf(format, args...)
		if strings.Contains(text, "://") {
			return
		}
		fmt.Fprintf(os.Stderr, "tailscale: %s\n", text)
	}
	return server
}

// SignIn starts the node and waits until it is logged in. open is called
// once with the browser approval URL, and again with the Tailscale
// machines page when key expiry is still on. status receives progress
// text. ctx bounds the wait for browser approval. After login, key
// expiry is watched on watch until it is off or watch is cancelled. A
// nil watch uses ctx. Cancelling that watch does not undo a finished
// login: the status stays on the key-expiry step, and the saved node
// still comes back at boot. Calling SignIn is the only path that may
// contact Tailscale before a saved identity exists.
func SignIn(ctx context.Context, dir, hostname string, open func(url string), status func(string), watch context.Context) error {
	already := HasIdentity(dir)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	server := newServer(dir, hostname)
	if err := server.Start(); err != nil {
		return err
	}
	defer func() {
		server.Close()
		if !already && !HasIdentity(dir) {
			_ = os.RemoveAll(dir)
		}
	}()

	localClient, err := server.LocalClient()
	if err != nil {
		return err
	}

	deadline := time.Now().Add(3 * time.Minute)
	opened := false
	asked := false
	for {
		if time.Now().After(deadline) {
			return errors.New("timed out waiting for Tailscale sign-in")
		}
		st, err := localClient.Status(ctx)
		if err != nil {
			return err
		}
		if st.BackendState == "Running" {
			if err := os.WriteFile(filepath.Join(dir, signedInMarker), []byte("ok\n"), 0o644); err != nil {
				return err
			}
			if watch == nil {
				watch = ctx
			}
			waitForKeyExpiry(watch, localClient, open, status)
			return nil
		}
		if server.AuthKey == "" && !asked && (st.BackendState == "NeedsLogin" || st.BackendState == "NoState") {
			if err := localClient.StartLoginInteractive(ctx); err != nil && !strings.Contains(err.Error(), "already") {
				return err
			}
			asked = true
		}
		if st.AuthURL != "" && !opened && open != nil {
			open(st.AuthURL)
			opened = true
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
}

const tailscaleMachinesURL = "https://login.tailscale.com/admin/machines"

func keyExpiryOffStatus() string {
	return "Signed in to Tailscale. Key expiry is off, so this PC stays available."
}

func keyExpiryPendingStatus(expiry time.Time) string {
	when := "the date Tailscale shows"
	if !expiry.IsZero() {
		when = expiry.UTC().Format("2 January 2006")
	}
	return "Signed in. Tailscale setup is not finished until key expiry is off. On the Machines page, open this PC and choose Disable Key Expiry. Sign in there with the account that owns the tailnet. Until you do, this PC drops off on " + when + "."
}

// waitForKeyExpiry stays on the admin step until key expiry is off.
// A node cannot turn that off for itself. Only the tailnet owner can,
// and setup does not call Tailscale finished before that. Cancelling
// ctx leaves the pending status in place.
func waitForKeyExpiry(ctx context.Context, lc *local.Client, open func(string), status func(string)) {
	opened := false
	announce := func(expiry time.Time) bool {
		if expiry.IsZero() {
			report(status, keyExpiryOffStatus())
			return true
		}
		if !opened && open != nil {
			open(tailscaleMachinesURL)
			opened = true
		}
		report(status, keyExpiryPendingStatus(expiry))
		return false
	}
	if expiry, err := readKeyExpiry(ctx, lc); err == nil && announce(expiry) {
		return
	}
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			expiry, err := readKeyExpiry(ctx, lc)
			if err != nil {
				continue
			}
			if announce(expiry) {
				return
			}
		}
	}
}

func readKeyExpiry(ctx context.Context, lc *local.Client) (time.Time, error) {
	if lc == nil {
		return time.Time{}, errors.New("no local client")
	}
	st, err := lc.Status(ctx)
	if err != nil {
		return time.Time{}, err
	}
	if st == nil || st.Self == nil || st.Self.KeyExpiry == nil || st.Self.KeyExpiry.IsZero() {
		return time.Time{}, nil
	}
	return st.Self.KeyExpiry.UTC(), nil
}

func report(status func(string), text string) {
	if status != nil {
		status(text)
	}
}

// CurrentKeyExpiry reports when the running node's key expires.
// The zero time means key expiry is off.
func CurrentKeyExpiry(ctx context.Context, server *tsnet.Server) (time.Time, error) {
	lc, err := server.LocalClient()
	if err != nil {
		return time.Time{}, err
	}
	st, err := lc.Status(ctx)
	if err != nil {
		return time.Time{}, err
	}
	if st.Self == nil || st.Self.KeyExpiry == nil || st.Self.KeyExpiry.IsZero() {
		return time.Time{}, nil
	}
	return st.Self.KeyExpiry.UTC(), nil
}

// Listen serves TCP on the tailnet. It does not start a node when dir has
// no saved identity.
func Listen(dir, hostname string) (net.Listener, *tsnet.Server, error) {
	if !HasIdentity(dir) {
		return nil, nil, ErrNoIdentity
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, nil, err
	}
	server := newServer(dir, hostname)
	if err := server.Start(); err != nil {
		return nil, nil, err
	}
	ln, err := server.Listen("tcp", ":5900")
	if err != nil {
		server.Close()
		return nil, nil, err
	}
	return ln, server, nil
}
