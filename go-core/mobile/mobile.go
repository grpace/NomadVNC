// Package mobile exposes the NomadVNC engine to React Native via gomobile.
//
// The functions use only gomobile-bind-compatible signatures (strings,
// ints, bools, error returns) and exchange JSON payloads whose shapes match
// the TypeScript contracts in packages/platform-contracts. The React Native
// side (NomadNativeModule on iOS/Android) parses the JSON and forwards
// engine events to JavaScript by polling PollEvents on a timer.
package mobile

import (
	"context"
	"encoding/json"

	"github.com/nomadvnc/nomadvnc/go-core/internal/config"
	"github.com/nomadvnc/nomadvnc/go-core/internal/engine"
	"github.com/nomadvnc/nomadvnc/go-core/internal/session"
)

var sharedEngine = engine.New(config.Default())

// ConfigureStateDir must be called once at app startup with a writable
// app-support directory. The embedded tsnet node persists its identity and
// control-plane state there.
func ConfigureStateDir(stateDir string) {
	Configure(stateDir, "")
}

// Configure is ConfigureStateDir plus the device's own name (the iPhone
// name, the Android device name). That name becomes the automatic tailnet
// hostname. os.Hostname on iOS is "localhost", which would otherwise
// register the node as NomadVNC-localhost.
func Configure(stateDir, suggestedHost string) {
	cfg := config.Default()
	cfg.StateDir = stateDir
	auto := config.AutomaticHostname(suggestedHost)
	cfg.Hostname = auto
	cfg.DefaultHostname = auto
	sharedEngine = engine.New(cfg)
}

// SetTailscaleHostname stores a name chosen in Settings. An empty name
// restores the automatic one. A running node is renamed immediately.
// Tailscale is not started.
func SetTailscaleHostname(hostname string) (string, error) {
	result, err := sharedEngine.SetTailscaleHostname(context.Background(), hostname)
	if err != nil {
		return "", err
	}
	return marshal(result)
}

func EnsureTailnetReady() (string, error) {
	state, err := sharedEngine.EnsureTailnetReady(context.Background())
	if err != nil {
		return "", err
	}
	return marshal(state)
}

func GetTailnetState() (string, error) {
	state, err := sharedEngine.GetTailnetState(context.Background())
	if err != nil {
		return "", err
	}
	return marshal(state)
}

func GetTailnetPeers() (string, error) {
	peers, err := sharedEngine.GetTailnetPeers(context.Background())
	if err != nil {
		return "", err
	}
	return marshal(peers)
}

// LogoutTailnet signs the embedded node out (switch-account path); the
// stored identity is kept.
func LogoutTailnet() (string, error) {
	state, err := sharedEngine.LogoutTailnet(context.Background())
	if err != nil {
		return "", err
	}
	return marshal(state)
}

// ReauthenticateTailnet forces a fresh interactive sign-in even while the
// node is still running (expiring-soon path).
func ReauthenticateTailnet() (string, error) {
	state, err := sharedEngine.ReauthenticateTailnet(context.Background())
	if err != nil {
		return "", err
	}
	return marshal(state)
}

// ResetTailnetIdentity wipes the persistent tsnet identity so the next
// bring-up registers a brand-new device.
func ResetTailnetIdentity() (string, error) {
	state, err := sharedEngine.ResetTailnetIdentity(context.Background())
	if err != nil {
		return "", err
	}
	return marshal(state)
}

// GetPeerPath reports how tailnet traffic reaches a host (direct/relay).
func GetPeerPath(host string) (string, error) {
	path, err := sharedEngine.GetPeerPath(context.Background(), host)
	if err != nil {
		return "", err
	}
	return marshal(path)
}

// StartVncSession starts a loopback WebSocket->TCP proxy for the target.
// direct mirrors StartSessionParams.Direct: true for user-typed manual
// hosts (local-first path, dialed via the OS network when the tailnet is
// down), false for tailnet device picks (login required).
func StartVncSession(host string, port int, token string, direct bool) (string, error) {
	result, err := sharedEngine.StartVncSession(context.Background(), session.StartSessionParams{
		Host:         host,
		Port:         port,
		SessionToken: token,
		Direct:       direct,
	})
	if err != nil {
		return "", err
	}
	return marshal(result)
}

func StopVncSession(sessionID string) error {
	return sharedEngine.StopVncSession(context.Background(), sessionID)
}

// PollEvents drains pending engine events without blocking and returns
// them as a JSON array of session.Event. The native module polls this on
// a timer (~500ms) and forwards each event to JavaScript. Engine emit is
// already non-blocking with a bounded buffer, so polling can never stall
// the engine; bursts beyond the buffer are dropped at the source.
func PollEvents() string {
	out, err := json.Marshal(drainEvents(sharedEngine.Events()))
	if err != nil {
		return "[]"
	}
	return string(out)
}

func drainEvents(ch <-chan session.Event) []json.RawMessage {
	events := make([]json.RawMessage, 0, 8)
	for {
		select {
		case ev := <-ch:
			payload, err := json.Marshal(ev)
			if err != nil {
				continue
			}
			events = append(events, payload)
		default:
			return events
		}
	}
}

func marshal(value any) (string, error) {
	payload, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return string(payload), nil
}
