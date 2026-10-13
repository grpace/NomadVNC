package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"sync/atomic"
	"time"

	"github.com/nomadvnc/nomadvnc/go-core/internal/hostcore"
	"github.com/nomadvnc/nomadvnc/go-core/internal/rfb"
)

var (
	frameW atomic.Int32
	frameH atomic.Int32
)

func trackedCapture() (rfb.Frame, error) {
	frame, err := captureScreen()
	if err != nil {
		return frame, err
	}
	frameW.Store(int32(frame.Width))
	frameH.Store(int32(frame.Height))
	return frame, nil
}

func runSession(ctx context.Context) error {
	enableDPIAware()
	startCaptureWorker()
	startInputWorker()
	cfg, err := readSessionConfig(os.Stdin)
	if err != nil {
		return fmt.Errorf("session settings from the service: %w", err)
	}
	password := cfg.Password
	if err := hostcore.ValidatePassword(password); err != nil {
		return err
	}

	var ready rfb.Frame
	for {
		ready, err = trackedCapture()
		if err == nil {
			break
		}
		logf("screen capture: %v", err)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
	logf("sharing a %dx%d screen", ready.Width, ready.Height)

	ln, err := net.Listen("tcp", hostcore.HelperListen)
	if err != nil {
		return err
	}
	defer ln.Close()

	server := &rfb.Server{
		Password: password,
		Name:     cfg.Title,
		Capture:  trackedCapture,
		Pointer: func(x, y int, buttons byte) {
			injectPointer(x, y, buttons, int(frameW.Load()), int(frameH.Load()))
		},
		Key:          injectKey,
		Disconnected: releaseInput,
		Log:          func(msg string) { logf("%s", msg) },
	}
	logf("session listening on %s", hostcore.HelperListen)
	return server.Serve(ctx, ln)
}

// sessionConfig is what the service hands the screen session on its
// stdin, so the session takes viewers without opening the data folder.
type sessionConfig struct {
	Password string `json:"password"`
	Title    string `json:"title"`
}

func readSessionConfig(r io.Reader) (sessionConfig, error) {
	var cfg sessionConfig
	err := json.NewDecoder(io.LimitReader(r, 4096)).Decode(&cfg)
	return cfg, err
}
