package main

import (
	"bufio"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"

	"github.com/nomadvnc/nomadvnc/go-core/internal/config"
	"github.com/nomadvnc/nomadvnc/go-core/internal/engine"
	"github.com/nomadvnc/nomadvnc/go-core/internal/session"
)

// responseWriter serializes newline-delimited JSON replies; requests and
// engine events write from many goroutines.
type responseWriter struct {
	mu  sync.Mutex
	out io.Writer
}

func (w *responseWriter) write(response session.Response) {
	w.mu.Lock()
	defer w.mu.Unlock()
	encoded, _ := json.Marshal(response)
	_, _ = fmt.Fprintln(w.out, string(encoded))
}

func main() {
	authKeyFlag := flag.String("authkey", "", "Tailscale auth key for headless (non-interactive) login")
	flag.Parse()

	cfg := config.Default()
	if stateDir := os.Getenv("NOMADVNC_STATE_DIR"); stateDir != "" {
		cfg.StateDir = stateDir
	}
	cfg.DefaultHostname = config.DefaultTailscaleHostname()
	if h := strings.TrimSpace(os.Getenv("NOMADVNC_TSNET_HOSTNAME")); h != "" {
		if name, err := config.NormalizeChosenHostname(h); err == nil && name != "" {
			cfg.Hostname = name
		}
	}
	// Flag wins over the environment so scripts can override an ambient key.
	if key := strings.TrimSpace(*authKeyFlag); key != "" {
		cfg.AuthKey = key
	} else if key := strings.TrimSpace(os.Getenv("NOMADVNC_AUTHKEY")); key != "" {
		cfg.AuthKey = key
	}
	// Optional self-hosted coordination server (Headscale). Empty keeps the
	// default Tailscale control plane.
	if u := strings.TrimSpace(os.Getenv("NOMADVNC_TS_CONTROL_URL")); u != "" {
		cfg.ControlURL = u
	}

	eng := engine.New(cfg)
	writer := &responseWriter{out: os.Stdout}

	go func() {
		for event := range eng.Events() {
			writer.write(session.Response{
				OK:    true,
				Event: &event,
			})
		}
	}()

	serve(os.Stdin, writer, func(request session.Request) {
		handleRequest(context.Background(), writer, eng, request)
	})
}

// serve reads newline-delimited requests until in closes. Requests are
// independent and answered by ID, so each runs on its own goroutine: a
// slow call (disco ping, auth-key login wait) must not hold up
// stopVncSession or a direct connect queued behind it.
func serve(in io.Reader, writer *responseWriter, handle func(session.Request)) {
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		var request session.Request
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil {
			writer.write(session.Response{ID: request.ID, OK: false, Error: err.Error()})
			continue
		}
		go handle(request)
	}
	// Input closed means the app is gone: return (and exit) right away
	// rather than lingering on in-flight calls nobody will read.
}

func handleRequest(ctx context.Context, writer *responseWriter, eng *engine.Engine, request session.Request) {
	switch request.Method {
	case "ensureTailnetReady":
		state, err := eng.EnsureTailnetReady(ctx)
		writeResult(writer, request.ID, state, err)
	case "getTailnetPeers":
		peers, err := eng.GetTailnetPeers(ctx)
		writeResult(writer, request.ID, peers, err)
	case "startVncSession":
		var params session.StartSessionParams
		err := json.Unmarshal(request.Params, &params)
		if err != nil {
			writeResult(writer, request.ID, nil, err)
			return
		}
		result, runErr := eng.StartVncSession(ctx, params)
		writeResult(writer, request.ID, result, runErr)
	case "stopVncSession":
		var params session.StopSessionParams
		err := json.Unmarshal(request.Params, &params)
		if err != nil {
			writeResult(writer, request.ID, nil, err)
			return
		}
		writeResult(writer, request.ID, map[string]bool{"ok": true}, eng.StopVncSession(ctx, params.SessionID))
	case "getTailnetState":
		state, err := eng.GetTailnetState(ctx)
		writeResult(writer, request.ID, state, err)
	case "logoutTailnet":
		loggedOut, err := eng.LogoutTailnet(ctx)
		writeResult(writer, request.ID, loggedOut, err)
	case "reauthenticateTailnet":
		reauthenticated, err := eng.ReauthenticateTailnet(ctx)
		writeResult(writer, request.ID, reauthenticated, err)
	case "resetTailnetIdentity":
		reset, err := eng.ResetTailnetIdentity(ctx)
		writeResult(writer, request.ID, reset, err)
	case "setTailscaleHostname":
		var params struct {
			Hostname string `json:"hostname"`
		}
		if len(request.Params) > 0 {
			if err := json.Unmarshal(request.Params, &params); err != nil {
				writeResult(writer, request.ID, nil, err)
				return
			}
		}
		result, err := eng.SetTailscaleHostname(ctx, params.Hostname)
		writeResult(writer, request.ID, result, err)
	case "getPeerPath":
		var params session.PeerPathParams
		err := json.Unmarshal(request.Params, &params)
		if err != nil {
			writeResult(writer, request.ID, nil, err)
			return
		}
		path, pathErr := eng.GetPeerPath(ctx, params.Host)
		writeResult(writer, request.ID, path, pathErr)
	default:
		writeResult(writer, request.ID, nil, fmt.Errorf("unknown method %q", request.Method))
	}
}

func writeResult(writer *responseWriter, id string, result any, err error) {
	if err != nil {
		writer.write(session.Response{ID: id, OK: false, Error: err.Error()})
		return
	}
	writer.write(session.Response{ID: id, OK: true, Result: result})
}
