package hostnet

import (
	"context"
	"encoding/json"
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

// SignIn starts the node, waits until it is logged in, and returns the
// node key's expiry (zero when expiry is off). open is called with the
// browser approval URL; status receives progress text. ctx bounds the wait
// for browser approval. The node is closed on return, so the service can
// take over the saved identity at once: two nodes must never run from one
// state directory. Calling SignIn is the only path that may contact
// Tailscale before a saved identity exists.
func SignIn(ctx context.Context, dir, hostname string, open func(url string), status func(string)) (time.Time, error) {
	already := HasIdentity(dir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return time.Time{}, err
	}
	server := newServer(dir, hostname)
	if err := server.Start(); err != nil {
		return time.Time{}, err
	}
	defer func() {
		server.Close()
		if !already && !HasIdentity(dir) {
			_ = os.RemoveAll(dir)
		}
	}()

	localClient, err := server.LocalClient()
	if err != nil {
		return time.Time{}, err
	}

	deadline := time.Now().Add(3 * time.Minute)
	opened := false
	asked := false
	for {
		if time.Now().After(deadline) {
			return time.Time{}, errors.New("timed out waiting for Tailscale sign-in")
		}
		st, err := localClient.Status(ctx)
		if err != nil {
			return time.Time{}, err
		}
		if st.BackendState == "Running" {
			if err := os.WriteFile(filepath.Join(dir, signedInMarker), []byte("ok\n"), 0o600); err != nil {
				return time.Time{}, err
			}
			report(status, "Signed in to Tailscale.")
			return readKeyExpiry(ctx, localClient)
		}
		if server.AuthKey == "" && !asked && (st.BackendState == "NeedsLogin" || st.BackendState == "NoState") {
			if err := localClient.StartLoginInteractive(ctx); err != nil && !strings.Contains(err.Error(), "already") {
				return time.Time{}, err
			}
			asked = true
		}
		if st.AuthURL != "" && !opened && open != nil {
			open(st.AuthURL)
			opened = true
		}
		select {
		case <-ctx.Done():
			return time.Time{}, ctx.Err()
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

// WaitForKeyExpiryOff stays on the admin step until key expiry is off, as
// reported by the running service in the status file. A node cannot turn
// expiry off for itself; only the tailnet owner can, and setup does not
// call Tailscale finished before that. Cancelling ctx leaves the pending
// status in place.
func WaitForKeyExpiryOff(ctx context.Context, dir string, expiry time.Time, open func(string), status func(string)) {
	if expiry.IsZero() {
		report(status, keyExpiryOffStatus())
		return
	}
	if open != nil {
		open(tailscaleMachinesURL)
	}
	report(status, keyExpiryPendingStatus(expiry))
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			st, err := ReadStatus(dir)
			if err != nil || st.State != "Running" || time.Since(st.Updated) > time.Minute {
				continue
			}
			if st.KeyExpiry.IsZero() {
				report(status, keyExpiryOffStatus())
				return
			}
			report(status, keyExpiryPendingStatus(st.KeyExpiry))
		}
	}
}

// Status is what the service last saw of its node, for the setup window.
type Status struct {
	State     string    `json:"state"`
	KeyExpiry time.Time `json:"keyExpiry"`
	Updated   time.Time `json:"updated"`
}

const statusFile = "nomadvnc-status.json"

// ReadStatus reads the status the service last wrote.
func ReadStatus(dir string) (Status, error) {
	var st Status
	data, err := os.ReadFile(filepath.Join(dir, statusFile))
	if err != nil {
		return st, err
	}
	err = json.Unmarshal(data, &st)
	return st, err
}

func writeStatus(dir string, st Status) {
	data, err := json.Marshal(st)
	if err != nil {
		return
	}
	tmp := filepath.Join(dir, statusFile+".tmp")
	if os.WriteFile(tmp, data, 0o600) == nil {
		_ = os.Rename(tmp, filepath.Join(dir, statusFile))
	}
}

// StatusInterval is how often Watch checks the node.
const StatusInterval = 10 * time.Second

// UnhealthyAfter is how long the node may be anything but Running (other
// than signed out) before Watch asks for a restart.
const UnhealthyAfter = 2 * time.Minute

// Watch keeps the status file current and logs state changes. It returns
// an error when the node has not been running for UnhealthyAfter, so the
// caller can restart it, and nil when ctx ends. A signed-out node is
// reported but not restarted: only a new sign-in fixes that.
func Watch(ctx context.Context, server *tsnet.Server, dir string, logf func(string, ...any)) error {
	lc, err := server.LocalClient()
	if err != nil {
		return err
	}
	ticker := time.NewTicker(StatusInterval)
	defer ticker.Stop()
	var badSince time.Time
	last := ""
	for {
		state, expiry := "Unknown", time.Time{}
		if st, err := lc.Status(ctx); err == nil {
			state = st.BackendState
			if st.Self != nil && st.Self.KeyExpiry != nil {
				expiry = st.Self.KeyExpiry.UTC()
			}
		}
		now := time.Now()
		writeStatus(dir, Status{State: state, KeyExpiry: expiry, Updated: now})
		if state != last {
			if state == "NeedsLogin" {
				logf("tailscale: signed out (key expired or this PC was removed). Open NomadVNC Host and choose Sign In with Tailscale")
			} else {
				logf("tailscale: %s", state)
			}
			last = state
		}
		switch {
		case state == "Running" || state == "NeedsLogin":
			badSince = time.Time{}
		case badSince.IsZero():
			badSince = now
		case now.Sub(badSince) >= UnhealthyAfter:
			return fmt.Errorf("tailscale not connected for %s (state %s)", UnhealthyAfter, state)
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
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
func Listen(dir, hostname string, port int) (net.Listener, *tsnet.Server, error) {
	if !HasIdentity(dir) {
		return nil, nil, ErrNoIdentity
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, nil, err
	}
	server := newServer(dir, hostname)
	if err := server.Start(); err != nil {
		return nil, nil, err
	}
	ln, err := server.Listen("tcp", fmt.Sprintf(":%d", port))
	if err != nil {
		server.Close()
		return nil, nil, err
	}
	return ln, server, nil
}
