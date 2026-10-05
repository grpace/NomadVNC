package engine

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/nomadvnc/nomadvnc/go-core/internal/config"
	"github.com/nomadvnc/nomadvnc/go-core/internal/proxy"
	"github.com/nomadvnc/nomadvnc/go-core/internal/session"
	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tsnet"
)

type Engine struct {
	cfg      config.EngineConfig
	mu       sync.Mutex
	server   *tsnet.Server
	local    *local.Client
	sessions map[string]*proxy.SessionProxy
	events   chan session.Event
	// tailnetReady reports the tailnet state for session setup. It defaults
	// to EnsureTailnetReady and is overridden in tests.
	tailnetReady func(context.Context) (session.TailnetState, error)
}

func New(cfg config.EngineConfig) *Engine {
	e := &Engine{
		cfg:      cfg,
		sessions: make(map[string]*proxy.SessionProxy),
		events:   make(chan session.Event, 32),
	}
	e.tailnetReady = e.EnsureTailnetReady
	return e
}

func (e *Engine) Events() <-chan session.Event {
	return e.events
}

func (e *Engine) EnsureTailnetReady(ctx context.Context) (session.TailnetState, error) {
	lc, err := e.ensureServer()
	if err != nil {
		return session.TailnetState{}, err
	}

	state, err := e.snapshotTailnetState(ctx, lc)
	if err != nil {
		return session.TailnetState{}, err
	}

	// Give tsnet a moment to initialize its saved state
	for i := 0; i < 50; i++ {
		if state.BackendState != "Starting" && state.BackendState != "NoState" {
			break
		}
		time.Sleep(100 * time.Millisecond)
		state, _ = e.snapshotTailnetState(ctx, lc)
	}

	if state.BackendState == "NeedsLogin" || state.BackendState == "NoState" {
		if e.cfg.AuthKey == "" {
			if loginErr := lc.StartLoginInteractive(ctx); loginErr != nil && !strings.Contains(loginErr.Error(), "already") {
				return state, loginErr
			}
		} else {
			// Headless auth-key mode: no browser to interact with.
			// tsnet applies the auth key asynchronously, so the backend
			// can report NeedsLogin briefly while the login is in flight.
			// Wait for it to settle before declaring the key rejected.
			deadline := time.Now().Add(60 * time.Second)
			for state.BackendState == "NeedsLogin" || state.BackendState == "NoState" || state.BackendState == "Starting" {
				if time.Now().After(deadline) {
					break
				}
				select {
				case <-ctx.Done():
					return state, ctx.Err()
				case <-time.After(500 * time.Millisecond):
				}
				state, _ = e.snapshotTailnetState(ctx, lc)
			}
			if state.BackendState == "NeedsLogin" || state.BackendState == "NoState" {
				return state, fmt.Errorf("tailnet login required but the configured auth key was not accepted")
			}
		}
		state, err = e.snapshotTailnetState(ctx, lc)
		if err != nil {
			return session.TailnetState{}, err
		}
		if state.AuthURL != "" {
			e.emit(session.Event{Type: "authUrl", AuthURL: state.AuthURL})
		}
	}

	e.emit(session.Event{Type: "tailnetState", TailnetState: &state})
	return state, nil
}

// GetTailnetState reports the node's state. Reading state must never be
// what brings a tailnet node up: for a user who has never signed in (no
// persisted identity, no auth key) it reports "NoState" without starting
// tsnet, so the app makes no contact with the coordination server until
// the user opts in via EnsureTailnetReady.
func (e *Engine) GetTailnetState(ctx context.Context) (session.TailnetState, error) {
	e.mu.Lock()
	running := e.server != nil
	e.mu.Unlock()
	if !running && e.cfg.AuthKey == "" && !hasPersistedIdentity(e.cfg.StateDir) {
		return session.TailnetState{BackendState: "NoState"}, nil
	}

	lc, err := e.ensureServer()
	if err != nil {
		return session.TailnetState{}, err
	}

	return e.snapshotTailnetState(ctx, lc)
}

// ReauthenticateTailnet forces a fresh interactive sign-in even while the
// node is still Running (the expiring-soon path). Headless auth-key mode has
// no browser to complete the flow, so it reports a clear error instead of
// hanging.
func (e *Engine) ReauthenticateTailnet(ctx context.Context) (session.TailnetState, error) {
	if e.cfg.AuthKey != "" {
		return session.TailnetState{}, fmt.Errorf("interactive re-authentication is unavailable in auth-key mode; rotate the auth key and restart the sidecar")
	}

	lc, err := e.ensureServer()
	if err != nil {
		return session.TailnetState{}, err
	}

	if loginErr := lc.StartLoginInteractive(ctx); loginErr != nil && !strings.Contains(loginErr.Error(), "already") {
		return session.TailnetState{}, loginErr
	}

	state, err := e.snapshotTailnetState(ctx, lc)
	if err != nil {
		return session.TailnetState{}, err
	}
	e.emit(session.Event{Type: "tailnetState", TailnetState: &state})
	return state, nil
}

// LogoutTailnet signs the embedded node out of the tailnet (switch-account
// path). The persistent identity is kept so the next sign-in is fast;
// close live sessions first — the caller owns that ordering.
func (e *Engine) LogoutTailnet(ctx context.Context) (session.TailnetState, error) {
	lc, err := e.ensureServer()
	if err != nil {
		return session.TailnetState{}, err
	}

	if err := lc.Logout(ctx); err != nil {
		return session.TailnetState{}, err
	}

	state, err := e.snapshotTailnetState(ctx, lc)
	if err != nil {
		return session.TailnetState{}, err
	}
	e.emit(session.Event{Type: "tailnetState", TailnetState: &state})
	return state, nil
}

func (e *Engine) GetTailnetPeers(ctx context.Context) ([]session.PeerDevice, error) {
	lc, err := e.ensureServer()
	if err != nil {
		return nil, err
	}

	status, err := lc.Status(ctx)
	if err != nil {
		return nil, err
	}

	peers := make([]session.PeerDevice, 0, len(status.Peer))
	for _, peerStatus := range status.Peer {
		if peerStatus == nil {
			continue
		}

		ips := make([]string, 0, len(peerStatus.TailscaleIPs))
		for _, ip := range peerStatus.TailscaleIPs {
			ips = append(ips, ip.String())
		}

		device := session.PeerDevice{
			StableID:    string(peerStatus.ID),
			DisplayName: chooseDisplayName(peerStatus),
			DNSName:     strings.TrimSuffix(peerStatus.DNSName, "."),
			TailnetIPs:  ips,
			Online:      peerStatus.Online,
			OS:          peerStatus.OS,
		}
		if !peerStatus.LastSeen.IsZero() {
			device.LastSeen = peerStatus.LastSeen.UTC().Format(time.RFC3339)
		}

		peers = append(peers, device)
	}

	slices.SortFunc(peers, func(left, right session.PeerDevice) int {
		if left.Online != right.Online {
			if left.Online {
				return -1
			}
			return 1
		}
		return strings.Compare(left.DisplayName, right.DisplayName)
	})

	return peers, nil
}

func (e *Engine) StartVncSession(ctx context.Context, params session.StartSessionParams) (session.StartSessionResult, error) {
	// Direct (local-first) connections must NEVER initialize the tailnet:
	// the user typed an address, so dial it on the OS network. Tailnet-only
	// targets (CGNAT range, MagicDNS) can't route this way and surface a
	// clear dial error from here.
	var dial func(dialCtx context.Context, network, address string) (net.Conn, error)
	if params.Direct {
		plainDialer := &net.Dialer{Timeout: 10 * time.Second}
		dial = plainDialer.DialContext
	} else {
		state, err := e.tailnetReady(ctx)
		if err != nil {
			return session.StartSessionResult{}, err
		}
		if !state.LoggedIn {
			return session.StartSessionResult{}, fmt.Errorf("tailnet login incomplete")
		}
		e.mu.Lock()
		server := e.server
		e.mu.Unlock()
		if server == nil {
			return session.StartSessionResult{}, fmt.Errorf("tailnet node is not running")
		}
		dial = server.Dial
	}

	e.mu.Lock()
	defer e.mu.Unlock()

	sessionID := uuid.NewString()
	target := fmt.Sprintf("%s:%d", params.Host, params.Port)
	token := params.SessionToken
	if token == "" {
		token = uuid.NewString()
	}

	sessionProxy := proxy.NewSessionProxy(
		sessionID,
		token,
		fmt.Sprintf("127.0.0.1:%d", params.PreferredLocalPort),
		target,
		dial,
	)

	wsURL, err := sessionProxy.Start()
	if err != nil {
		return session.StartSessionResult{}, err
	}

	e.sessions[sessionID] = sessionProxy
	e.emit(session.Event{Type: "connectionState", SessionID: sessionID, State: "connected", Message: "Local proxy ready"})

	return session.StartSessionResult{
		SessionID:   sessionID,
		WSURL:       wsURL,
		HTTPBaseURL: strings.TrimSuffix(wsURL, "/vnc?token="+token),
	}, nil
}

func (e *Engine) StopVncSession(ctx context.Context, sessionID string) error {
	e.mu.Lock()
	sessionProxy, ok := e.sessions[sessionID]
	if ok {
		delete(e.sessions, sessionID)
	}
	e.mu.Unlock()

	if !ok {
		return nil
	}

	e.emit(session.Event{Type: "connectionState", SessionID: sessionID, State: "disconnecting"})
	return sessionProxy.Close(ctx)
}

// ResetTailnetIdentity wipes the persistent tsnet identity (state dir) so the
// next bring-up registers a brand-new device on the tailnet. This is the
// escape hatch for a revoked, deleted, or otherwise unrecoverable node key:
// logout/login alone reuses the same identity. Refuses while sessions are
// live — the caller must disconnect first.
func (e *Engine) ResetTailnetIdentity(ctx context.Context) (session.TailnetState, error) {
	if err := e.closeAndWipeIdentity(); err != nil {
		return session.TailnetState{}, err
	}

	lc, err := e.ensureServer()
	if err != nil {
		return session.TailnetState{}, err
	}
	state, err := e.snapshotTailnetState(ctx, lc)
	if err != nil {
		return session.TailnetState{}, err
	}
	e.emit(session.Event{Type: "tailnetState", TailnetState: &state})
	return state, nil
}

// hasPersistedIdentity reports whether tsnet has saved a node identity in
// dir, i.e. the user signed in at some point (or an auth key was used).
func hasPersistedIdentity(dir string) bool {
	_, err := os.Stat(filepath.Join(dir, "tailscaled.state"))
	return err == nil
}

// closeAndWipeIdentity stops the node (if running) and deletes the persistent
// identity from the state dir. Split out so the wipe is unit-testable without
// bringing a real tsnet node back up.
func (e *Engine) closeAndWipeIdentity() error {
	e.mu.Lock()
	defer e.mu.Unlock()

	if len(e.sessions) > 0 {
		return fmt.Errorf("disconnect all sessions before resetting the tailnet identity")
	}
	if e.server != nil {
		_ = e.server.Close()
		e.server = nil
		e.local = nil
	}
	entries, err := os.ReadDir(e.cfg.StateDir)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	for _, entry := range entries {
		_ = os.RemoveAll(filepath.Join(e.cfg.StateDir, entry.Name()))
	}
	return nil
}

// ensureServer brings the embedded tsnet node up on first use and keeps it
// up for the life of the sidecar process. Lifecycle policy: the node stays
// connected while the app is open (the UI polls tailnet state every few
// seconds); quitting the app kills the sidecar, which shuts the node down.
func (e *Engine) ensureServer() (*local.Client, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	if e.server != nil && e.local != nil {
		return e.local, nil
	}

	if err := os.MkdirAll(filepath.Clean(e.cfg.StateDir), 0o755); err != nil {
		return nil, err
	}

	server := &tsnet.Server{
		Hostname:   e.cfg.Hostname,
		Dir:        e.cfg.StateDir,
		AuthKey:    e.cfg.AuthKey,
		ControlURL: e.cfg.ControlURL,
	}

	if err := server.Start(); err != nil {
		return nil, err
	}

	localClient, err := server.LocalClient()
	if err != nil {
		return nil, err
	}

	e.server = server
	e.local = localClient
	// A node that already signed in keeps its old name in prefs. Push
	// the configured name so iOS does not stay NomadVNC-localhost.
	// Failure here must not block bring-up; Settings can retry.
	if e.cfg.Hostname != "" {
		applyCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_ = applyTailscaleHostname(applyCtx, localClient, e.cfg.Hostname)
		cancel()
	}
	return localClient, nil
}

// SetTailscaleHostname stores the name this device should use on the
// tailnet. An empty raw value restores the automatic name. If the node
// is already running, the name is updated immediately. If it is not,
// the name is kept for the next start. This never starts Tailscale.
func (e *Engine) SetTailscaleHostname(ctx context.Context, raw string) (session.HostnameResult, error) {
	chosen, err := config.NormalizeChosenHostname(raw)
	if err != nil {
		return session.HostnameResult{}, err
	}

	e.mu.Lock()
	if chosen == "" {
		if e.cfg.DefaultHostname != "" {
			e.cfg.Hostname = e.cfg.DefaultHostname
		} else {
			e.cfg.Hostname = config.DefaultTailscaleHostname()
		}
	} else {
		e.cfg.Hostname = chosen
	}
	name := e.cfg.Hostname
	lc := e.local
	e.mu.Unlock()

	if lc == nil {
		return session.HostnameResult{Hostname: name, Applied: false}, nil
	}
	if err := applyTailscaleHostname(ctx, lc, name); err != nil {
		return session.HostnameResult{}, err
	}
	return session.HostnameResult{Hostname: name, Applied: true}, nil
}

func applyTailscaleHostname(ctx context.Context, lc *local.Client, name string) error {
	prefs := &ipn.MaskedPrefs{}
	prefs.HostnameSet = true
	prefs.Hostname = name
	_, err := lc.EditPrefs(ctx, prefs)
	return err
}

func (e *Engine) snapshotTailnetState(ctx context.Context, lc *local.Client) (session.TailnetState, error) {
	status, err := lc.Status(ctx)
	if err != nil {
		return session.TailnetState{}, err
	}

	return mapTailnetState(status), nil
}

func mapTailnetState(status *ipnstate.Status) session.TailnetState {
	state := session.TailnetState{
		LoggedIn:       status.BackendState == "Running",
		InMapPoll:      status.BackendState == "Running",
		BackendState:   status.BackendState,
		AuthURL:        status.AuthURL,
		SelfDeviceName: chooseDisplayName(status.Self),
	}

	if len(status.TailscaleIPs) > 0 {
		state.TailscaleIPv4 = status.TailscaleIPs[0].String()
	}
	if len(status.TailscaleIPs) > 1 {
		state.TailscaleIPv6 = status.TailscaleIPs[1].String()
	}

	if self := status.Self; self != nil && self.KeyExpiry != nil && !self.KeyExpiry.IsZero() {
		state.KeyExpiry = self.KeyExpiry.UTC().Format(time.RFC3339)
	}

	return state
}

func chooseDisplayName(peer *ipnstate.PeerStatus) string {
	if peer == nil {
		return ""
	}
	if peer.HostName != "" {
		return peer.HostName
	}
	if peer.DNSName != "" {
		return strings.TrimSuffix(peer.DNSName, ".")
	}
	return string(peer.ID)
}

func (e *Engine) emit(event session.Event) {
	select {
	case e.events <- event:
	default:
	}
}
