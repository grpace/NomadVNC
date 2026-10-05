package engine

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/nomadvnc/nomadvnc/go-core/internal/config"
	"github.com/nomadvnc/nomadvnc/go-core/internal/proxy"
	"github.com/nomadvnc/nomadvnc/go-core/internal/session"
	"tailscale.com/ipn/ipnstate"
)

func TestReauthenticateTailnetRefusesAuthKeyMode(t *testing.T) {
	dir := t.TempDir()
	eng := New(config.EngineConfig{StateDir: dir, AuthKey: "tskey-test"})
	_, err := eng.ReauthenticateTailnet(context.Background())
	if err == nil {
		t.Fatal("expected an error in auth-key mode, got nil")
	}
	if !strings.Contains(err.Error(), "auth-key mode") {
		t.Fatalf("error = %q, want auth-key mode guidance", err.Error())
	}
}

func TestMapTailnetStateKeyExpiry(t *testing.T) {
	expiry := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	status := &ipnstate.Status{
		BackendState: "Running",
		Self:         &ipnstate.PeerStatus{KeyExpiry: &expiry},
	}

	mapped := mapTailnetState(status)
	if mapped.KeyExpiry != "2026-10-01T12:00:00Z" {
		t.Fatalf("KeyExpiry = %q, want RFC3339 of the self node expiry", mapped.KeyExpiry)
	}

	mapped = mapTailnetState(&ipnstate.Status{BackendState: "Running"})
	if mapped.KeyExpiry != "" {
		t.Fatalf("KeyExpiry = %q, want empty when the control plane reports none", mapped.KeyExpiry)
	}
}

func TestCloseAndWipeIdentityRefusesLiveSessions(t *testing.T) {
	dir := t.TempDir()
	engine := New(config.EngineConfig{StateDir: dir})
	// A live session must block the wipe even before any server exists.
	engine.sessions["session-1"] = (*proxy.SessionProxy)(nil)

	if err := engine.closeAndWipeIdentity(); err == nil {
		t.Fatal("expected an error when sessions are live, got nil")
	}
}

func TestCloseAndWipeIdentityWipesStateDir(t *testing.T) {
	dir := t.TempDir()
	stale := filepath.Join(dir, "tailscaled.state")
	if err := os.WriteFile(stale, []byte("stale-identity"), 0o600); err != nil {
		t.Fatal(err)
	}

	engine := New(config.EngineConfig{StateDir: dir, Hostname: "test-reset"})
	if err := engine.closeAndWipeIdentity(); err != nil {
		t.Fatalf("closeAndWipeIdentity: %v", err)
	}
	if _, err := os.Stat(stale); !os.IsNotExist(err) {
		t.Fatalf("stale state file survived the reset: %v", err)
	}
	if engine.server != nil || engine.local != nil {
		t.Fatal("server/local handles survived the wipe")
	}
}

func TestStartVncSessionDirectSkipsTailnetLoginGate(t *testing.T) {
	dir := t.TempDir()
	engine := New(config.EngineConfig{StateDir: dir})
	// Simulate a tailnet that never logged in (local-first user, no Tailscale).
	engine.tailnetReady = func(context.Context) (session.TailnetState, error) {
		return session.TailnetState{}, nil
	}

	// A tailnet-device session still requires login.
	_, err := engine.StartVncSession(context.Background(), session.StartSessionParams{
		Host: "lab.tail.ts.net", Port: 5900, SessionToken: "tok",
	})
	if err == nil || !strings.Contains(err.Error(), "tailnet login incomplete") {
		t.Fatalf("tailnet session without login: err = %v, want tailnet login incomplete", err)
	}

	// A user-typed direct host starts without tailnet login.
	res, err := engine.StartVncSession(context.Background(), session.StartSessionParams{
		Host: "127.0.0.1", Port: 5901, SessionToken: "tok", Direct: true,
	})
	if err != nil {
		t.Fatalf("direct session without login: err = %v", err)
	}
	if res.SessionID == "" || res.WSURL == "" {
		t.Fatalf("direct session returned an empty result: %+v", res)
	}
	if err := engine.StopVncSession(context.Background(), res.SessionID); err != nil {
		t.Fatalf("StopVncSession: %v", err)
	}
}

func TestStartVncSessionDirectNeverTouchesTailnet(t *testing.T) {
	dir := t.TempDir()
	engine := New(config.EngineConfig{StateDir: dir})
	// Fail loudly if the direct path initializes the tailnet at all.
	engine.tailnetReady = func(context.Context) (session.TailnetState, error) {
		t.Error("direct StartVncSession called tailnetReady — direct mode must never initialize tsnet")
		return session.TailnetState{}, nil
	}

	res, err := engine.StartVncSession(context.Background(), session.StartSessionParams{
		Host: "127.0.0.1", Port: 5901, SessionToken: "tok", Direct: true,
	})
	if err != nil {
		t.Fatalf("direct session: err = %v", err)
	}
	if err := engine.StopVncSession(context.Background(), res.SessionID); err != nil {
		t.Fatalf("StopVncSession: %v", err)
	}
}

// Mobile relies on this: it sends no token (Hermes has no Web Crypto), so
// the engine must mint an unguessable one per session.
func TestStartVncSessionMintsRandomTokenWhenNoneGiven(t *testing.T) {
	eng := New(config.EngineConfig{StateDir: t.TempDir()})
	tokens := map[string]bool{}
	for i := 0; i < 2; i++ {
		result, err := eng.StartVncSession(context.Background(), session.StartSessionParams{
			Host:   "127.0.0.1",
			Port:   1,
			Direct: true,
		})
		if err != nil {
			t.Fatalf("start: %v", err)
		}
		defer func(id string) { _ = eng.StopVncSession(context.Background(), id) }(result.SessionID)
		token := result.WSURL[strings.Index(result.WSURL, "token=")+len("token="):]
		if len(token) < 32 {
			t.Fatalf("token %q is too short to be unguessable", token)
		}
		tokens[token] = true
	}
	if len(tokens) != 2 {
		t.Fatal("expected a distinct token per session")
	}
}

// Local-first privacy: reading state for a user who never signed in must
// not start tsnet (which would contact the coordination server).
func TestGetTailnetStateDoesNotStartNodeBeforeFirstSignIn(t *testing.T) {
	eng := New(config.EngineConfig{StateDir: t.TempDir()})
	state, err := eng.GetTailnetState(context.Background())
	if err != nil {
		t.Fatalf("GetTailnetState: %v", err)
	}
	if state.LoggedIn || state.BackendState != "NoState" {
		t.Fatalf("state = %+v, want logged-out NoState", state)
	}
	if eng.server != nil {
		t.Fatal("reading state started the tailnet node")
	}
}
