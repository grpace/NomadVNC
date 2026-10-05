package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"time"
	"unsafe"

	"github.com/nomadvnc/nomadvnc/go-core/internal/hostcore"
	"github.com/nomadvnc/nomadvnc/go-core/internal/hostnet"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

const stillActive = 259

type serviceHandler struct{}

func runWindowsService() {
	if err := svc.Run(hostcore.ServiceName, &serviceHandler{}); err != nil {
		logf("service: %v", err)
	}
}

func (serviceHandler) Execute(_ []string, changes <-chan svc.ChangeRequest, status chan<- svc.Status) (bool, uint32) {
	status <- svc.Status{State: svc.StartPending}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() {
		runServiceBody(ctx)
		close(done)
	}()
	status <- svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}

	for {
		select {
		case change := <-changes:
			switch change.Cmd {
			case svc.Interrogate:
				status <- change.CurrentStatus
			case svc.Stop, svc.Shutdown:
				status <- svc.Status{State: svc.StopPending}
				cancel()
				<-done
				return false, 0
			}
		case <-done:
			return false, 1
		}
	}
}

func runServiceBody(ctx context.Context) {
	logf("service started")
	defer logf("service stopped")

	go servePublic(ctx)
	go serveTailnet(ctx)
	superviseSession(ctx)
}

func servePublic(ctx context.Context) {
	serveListener(ctx, hostcore.PublicListen, "local network")
}

func serveTailnet(ctx context.Context) {
	dir := hostcore.TailscaleDir(dataDir())
	var lastErr string
	for {
		if ctx.Err() != nil {
			return
		}
		if !hostnet.HasIdentity(dir) {
			if !sleep(ctx, 5*time.Second) {
				return
			}
			continue
		}
		ln, server, err := hostnet.Listen(dir, deviceHostname())
		if err != nil {
			msg := err.Error()
			if msg != lastErr {
				logf("tailscale: %v", err)
				lastErr = msg
			}
			if !sleep(ctx, 15*time.Second) {
				return
			}
			continue
		}
		logf("tailscale listening as %s", deviceHostname())
		if expiry, err := hostnet.CurrentKeyExpiry(ctx, server); err == nil && !expiry.IsZero() {
			logf("tailscale key expires %s; turn off key expiry in the Tailscale admin page so this PC stays available", expiry.Format("2006-01-02"))
		}
		proxyErr := hostcore.Proxy(ctx, ln, dialHelper)
		server.Close()
		_ = ln.Close()
		if ctx.Err() != nil || proxyErr == nil {
			return
		}
		logf("tailscale proxy: %v", proxyErr)
		if !sleep(ctx, 5*time.Second) {
			return
		}
	}
}

func serveListener(ctx context.Context, addr, label string) {
	var lastErr string
	for {
		if ctx.Err() != nil {
			return
		}
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			msg := err.Error()
			if msg != lastErr {
				logf("%s listen: %v", label, err)
				lastErr = msg
			}
			if !sleep(ctx, 2*time.Second) {
				return
			}
			continue
		}
		logf("%s listening on %s", label, addr)
		err = hostcore.Proxy(ctx, ln, dialHelper)
		_ = ln.Close()
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			logf("%s proxy: %v", label, err)
		}
	}
}

func dialHelper(ctx context.Context) (net.Conn, error) {
	dialer := net.Dialer{Timeout: 2 * time.Second}
	return dialer.DialContext(ctx, "tcp", hostcore.HelperListen)
}

func sleep(ctx context.Context, d time.Duration) bool {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func superviseSession(ctx context.Context) {
	var (
		pid          uint32
		session      uint32
		signInScreen bool
		lastErr      string
	)
	exe, err := os.Executable()
	if err != nil {
		logf("session executable: %v", err)
		return
	}
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		if ctx.Err() != nil {
			stopSession(pid)
			return
		}
		active, ok := activeConsoleSession()
		switch {
		case pid != 0 && !processAlive(pid):
			logf("screen session exited")
			pid = 0
			signInScreen = false
		case pid != 0 && ok && active != session:
			logf("console session changed")
			stopSession(pid)
			pid = 0
			signInScreen = false
		case pid != 0 && signInScreen && userLoggedOn(active):
			logf("someone signed in to Windows")
			stopSession(pid)
			pid = 0
			signInScreen = false
		}
		if pid == 0 && ok {
			started, onSignIn, err := launchSession(active, exe)
			if err != nil {
				msg := err.Error()
				if msg != lastErr {
					logf("start screen session: %v", err)
					lastErr = msg
				}
			} else {
				pid = started
				session = active
				signInScreen = onSignIn
				lastErr = ""
				if onSignIn {
					logf("screen session %d sharing the Windows sign-in screen", pid)
				} else {
					logf("screen session %d in console session %d", pid, session)
				}
			}
		}
		select {
		case <-ctx.Done():
			stopSession(pid)
			return
		case <-ticker.C:
		}
	}
}

func activeConsoleSession() (uint32, bool) {
	id := windows.WTSGetActiveConsoleSessionId()
	if id == 0xFFFFFFFF {
		return 0, false
	}
	return id, true
}

func processAlive(pid uint32) bool {
	handle, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return false
	}
	defer windows.CloseHandle(handle)
	var code uint32
	if err := windows.GetExitCodeProcess(handle, &code); err != nil {
		return false
	}
	return code == stillActive
}

func stopSession(pid uint32) {
	if pid == 0 {
		return
	}
	handle, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, pid)
	if err != nil {
		return
	}
	defer windows.CloseHandle(handle)
	_ = windows.TerminateProcess(handle, 0)
}

func launchSession(sessionID uint32, exe string) (uint32, bool, error) {
	if pid, err := startSessionProcess(sessionID, exe, `winsta0\default`, false); err == nil {
		return pid, false, nil
	} else {
		logf("signed-in desktop unavailable (%v); sharing the Windows sign-in screen", err)
	}
	pid, err := startSessionProcess(sessionID, exe, `winsta0\Winlogon`, true)
	if err != nil {
		return 0, false, err
	}
	return pid, true, nil
}

func userLoggedOn(sessionID uint32) bool {
	var token windows.Token
	if err := windows.WTSQueryUserToken(sessionID, &token); err != nil {
		return false
	}
	token.Close()
	return true
}

func startSessionProcess(sessionID uint32, exe, desktop string, asSystem bool) (uint32, error) {
	var primary windows.Token
	if asSystem {
		token, err := systemTokenForSession(sessionID)
		if err != nil {
			return 0, err
		}
		primary = token
	} else {
		var userToken windows.Token
		if err := windows.WTSQueryUserToken(sessionID, &userToken); err != nil {
			return 0, err
		}
		defer userToken.Close()
		if err := windows.DuplicateTokenEx(
			userToken,
			windows.TOKEN_ALL_ACCESS,
			nil,
			windows.SecurityImpersonation,
			windows.TokenPrimary,
			&primary,
		); err != nil {
			return 0, err
		}
	}
	defer primary.Close()

	var env *uint16
	if err := windows.CreateEnvironmentBlock(&env, primary, false); err != nil {
		env = nil
	} else {
		defer windows.DestroyEnvironmentBlock(env)
	}

	cmd, err := windows.UTF16FromString(fmt.Sprintf(`"%s" --session`, exe))
	if err != nil {
		return 0, err
	}
	desktopPtr, err := windows.UTF16PtrFromString(desktop)
	if err != nil {
		return 0, err
	}
	si := &windows.StartupInfo{
		Desktop:    desktopPtr,
		Flags:      windows.STARTF_USESHOWWINDOW,
		ShowWindow: windows.SW_HIDE,
	}
	si.Cb = uint32(unsafe.Sizeof(*si))
	var pi windows.ProcessInformation
	err = windows.CreateProcessAsUser(
		primary,
		nil,
		&cmd[0],
		nil,
		nil,
		false,
		windows.CREATE_UNICODE_ENVIRONMENT|windows.CREATE_NO_WINDOW,
		env,
		nil,
		si,
		&pi,
	)
	if err != nil {
		return 0, err
	}
	_ = windows.CloseHandle(pi.Thread)
	_ = windows.CloseHandle(pi.Process)
	if pi.ProcessId == 0 {
		return 0, errors.New("session process did not start")
	}
	return pi.ProcessId, nil
}

func systemTokenForSession(sessionID uint32) (windows.Token, error) {
	var self windows.Token
	if err := windows.OpenProcessToken(
		windows.CurrentProcess(),
		windows.TOKEN_DUPLICATE|windows.TOKEN_QUERY|windows.TOKEN_ASSIGN_PRIMARY|windows.TOKEN_ADJUST_SESSIONID,
		&self,
	); err != nil {
		return 0, err
	}
	defer self.Close()

	var primary windows.Token
	if err := windows.DuplicateTokenEx(
		self,
		windows.TOKEN_ALL_ACCESS,
		nil,
		windows.SecurityImpersonation,
		windows.TokenPrimary,
		&primary,
	); err != nil {
		return 0, err
	}
	sid := sessionID
	if err := windows.SetTokenInformation(
		primary,
		uint32(windows.TokenSessionId),
		(*byte)(unsafe.Pointer(&sid)),
		uint32(unsafe.Sizeof(sid)),
	); err != nil {
		primary.Close()
		return 0, err
	}
	return primary, nil
}
