package main

import (
	"context"
	"net"
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
	password, err := readPassword()
	if err != nil {
		return err
	}
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
	logf("sharing %dx%d desktop %s windows %d", ready.Width, ready.Height, currentDesktop(), visibleWindowCount())

	ln, err := net.Listen("tcp", hostcore.HelperListen)
	if err != nil {
		return err
	}
	defer ln.Close()

	server := &rfb.Server{
		Password: password,
		Name:     desktopTitle(),
		Capture:  trackedCapture,
		Pointer: func(x, y int, buttons byte) {
			injectPointer(x, y, buttons, int(frameW.Load()), int(frameH.Load()))
		},
		Key: injectKey,
		Log: func(msg string) { logf("%s", msg) },
	}
	logf("session listening on %s", hostcore.HelperListen)
	return server.Serve(ctx, ln)
}
