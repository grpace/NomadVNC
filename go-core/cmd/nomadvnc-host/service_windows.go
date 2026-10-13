package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
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
	// Re-protect data left open by older versions, which let every user
	// read the password and the Tailscale key.
	if err := lockDataDir(); err != nil {
		logf("protect data folder: %v", err)
	}

	go servePublic(ctx)
	go serveTailnet(ctx)
	superviseSession(ctx)
}

func servePublic(ctx context.Context) {
	serveListener(ctx, hostcore.ListenAddr(savedPort()), "local network")
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
		ln, server, err := hostnet.Listen(dir, deviceHostname(), savedPort())
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
		// The watchdog closes the listener when the node stays
		// disconnected, which ends Proxy and restarts the node below.
		watchCtx, stopWatch := context.WithCancel(ctx)
		go func() {
			if err := hostnet.Watch(watchCtx, server, dir, logf); err != nil {
				logf("restarting tailscale: %v", err)
				_ = ln.Close()
			}
		}()
		proxyErr := hostcore.Proxy(ctx, ln, dialHelper)
		stopWatch()
		server.Close()
		_ = ln.Close()
		if ctx.Err() != nil {
			return
		}
		if proxyErr != nil {
			logf("tailscale proxy: %v", proxyErr)
		}
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
	conn, err := dialer.DialContext(ctx, "tcp", hostcore.HelperListen)
	if err != nil {
		return nil, err
	}
	if err := verifyHelperConn(conn); err != nil {
		logf("refused to forward a viewer: %v", err)
		_ = conn.Close()
		return nil, err
	}
	return conn, nil
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

// superviseSession keeps one screen session running in the console
// session, the one on the PC's own screen. The screen session follows
// that screen through sign-in, lock and approval prompts by itself; only
// a different console session, as after switching users, needs a new one.
func superviseSession(ctx context.Context) {
	var (
		pid     uint32
		session uint32
		lastErr string
		// startedAt, quickExits and notBefore space out restarts of a
		// session that keeps stopping (hostcore.RestartDelay).
		startedAt  time.Time
		quickExits int
		notBefore  time.Time
		// The icon in the system tray of whoever is signed in. Closing
		// trayStop tells it to leave.
		trayPID   uint32
		trayStop  windows.Handle
		trayRetry time.Time
	)
	stopTray := func() {
		if trayStop != 0 {
			_ = windows.CloseHandle(trayStop)
		}
		trayPID, trayStop = 0, 0
	}
	defer stopTray()
	exe, err := os.Executable()
	if err != nil {
		logf("session executable: %v", err)
		return
	}
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	defer helperPID.Store(0)
	for {
		helperPID.Store(pid)
		if ctx.Err() != nil {
			stopSession(pid)
			return
		}
		active, ok := activeConsoleSession()
		switch {
		case pid != 0 && !processAlive(pid):
			pid = 0
			if time.Since(startedAt) < hostcore.SessionSettled {
				quickExits++
			} else {
				quickExits = 0
			}
			wait := hostcore.RestartDelay(quickExits)
			notBefore = time.Now().Add(wait)
			if wait > 0 {
				logf("screen session exited; starting it again in %v", wait)
			} else {
				logf("screen session exited")
			}
		case pid != 0 && ok && active != session:
			logf("console session changed")
			stopSession(pid)
			pid = 0
			quickExits = 0
			notBefore = time.Time{}
			stopTray()
		}
		if trayPID != 0 && !processAlive(trayPID) {
			stopTray()
		}
		// Nobody signed in is the usual reason this fails, so it is tried
		// again quietly.
		if trayPID == 0 && ok && trayWanted() && time.Now().After(trayRetry) {
			trayRetry = time.Now().Add(10 * time.Second)
			if started, stop, err := startTrayProcess(active, exe, savedPort()); err == nil {
				trayPID, trayStop = started, stop
			}
		}
		if pid == 0 && ok && !time.Now().Before(notBefore) {
			started, err := startSessionProcess(active, exe)
			if err != nil {
				msg := err.Error()
				if msg != lastErr {
					logf("start screen session: %v", err)
					lastErr = msg
				}
			} else {
				pid = started
				helperPID.Store(pid)
				session = active
				startedAt = time.Now()
				lastErr = ""
				logf("screen session %d in console session %d", pid, session)
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

// startSessionProcess starts the screen session in sessionID under the
// service's own account. Only that account may see and control the lock
// screen, the sign-in screen and approval prompts, and reach windows that
// run as administrator; a process running as the signed-in user gets none
// of those.
func startSessionProcess(sessionID uint32, exe string) (uint32, error) {
	primary, err := systemTokenForSession(sessionID)
	if err != nil {
		return 0, err
	}
	defer primary.Close()

	var env *uint16
	if err := windows.CreateEnvironmentBlock(&env, primary, false); err != nil {
		env = nil
	} else {
		defer windows.DestroyEnvironmentBlock(env)
	}

	password, err := readPassword()
	if err != nil {
		return 0, fmt.Errorf("read the VNC password: %w", err)
	}
	config, err := json.Marshal(sessionConfig{Password: password, Title: desktopTitle()})
	if err != nil {
		return 0, err
	}

	cmd, err := windows.UTF16FromString(fmt.Sprintf(`"%s" --session`, exe))
	if err != nil {
		return 0, err
	}
	// It starts on the desktop that is there from boot. Its capture and
	// input threads move to whichever desktop is showing.
	desktopPtr, err := windows.UTF16PtrFromString(`winsta0\Winlogon`)
	if err != nil {
		return 0, err
	}

	// stdin carries the settings in; stdout and stderr carry log lines out.
	// The session gets only its two pipe ends: the handle list stops it
	// inheriting anything else the service has open.
	inRead, inWrite, err := sessionPipe(true)
	if err != nil {
		return 0, err
	}
	defer windows.CloseHandle(inWrite)
	outRead, outWrite, err := sessionPipe(false)
	if err != nil {
		windows.CloseHandle(inRead)
		return 0, err
	}
	childEnds := []windows.Handle{inRead, outWrite}
	defer func() {
		for _, h := range childEnds {
			windows.CloseHandle(h)
		}
	}()
	attrs, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		windows.CloseHandle(outRead)
		return 0, err
	}
	defer attrs.Delete()
	if err := attrs.Update(windows.PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
		unsafe.Pointer(&childEnds[0]), uintptr(len(childEnds))*unsafe.Sizeof(childEnds[0])); err != nil {
		windows.CloseHandle(outRead)
		return 0, err
	}

	si := &windows.StartupInfoEx{
		StartupInfo: windows.StartupInfo{
			Desktop:    desktopPtr,
			Flags:      windows.STARTF_USESHOWWINDOW | windows.STARTF_USESTDHANDLES,
			ShowWindow: windows.SW_HIDE,
			StdInput:   inRead,
			StdOutput:  outWrite,
			StdErr:     outWrite,
		},
		ProcThreadAttributeList: attrs.List(),
	}
	si.Cb = uint32(unsafe.Sizeof(*si))
	var pi windows.ProcessInformation
	err = windows.CreateProcessAsUser(
		primary,
		nil,
		&cmd[0],
		nil,
		nil,
		true,
		windows.CREATE_UNICODE_ENVIRONMENT|windows.CREATE_NO_WINDOW|windows.EXTENDED_STARTUPINFO_PRESENT,
		env,
		nil,
		&si.StartupInfo,
		&pi,
	)
	if err != nil {
		windows.CloseHandle(outRead)
		return 0, err
	}
	_ = windows.CloseHandle(pi.Thread)
	_ = windows.CloseHandle(pi.Process)
	if pi.ProcessId == 0 {
		windows.CloseHandle(outRead)
		return 0, errors.New("session process did not start")
	}

	go copySessionLog(os.NewFile(uintptr(outRead), "session-log"))
	var written uint32
	if err := windows.WriteFile(inWrite, config, &written, nil); err != nil {
		logf("send session settings: %v", err)
	}
	return pi.ProcessId, nil
}

// startTrayProcess starts the tray icon as the person signed in to
// sessionID. It returns the write end of the icon's stdin: the icon leaves
// when that closes, which also covers the service stopping for any reason.
func startTrayProcess(sessionID uint32, exe string, port int) (uint32, windows.Handle, error) {
	var userToken windows.Token
	if err := windows.WTSQueryUserToken(sessionID, &userToken); err != nil {
		return 0, 0, err
	}
	defer userToken.Close()
	var primary windows.Token
	if err := windows.DuplicateTokenEx(userToken, windows.TOKEN_ALL_ACCESS, nil,
		windows.SecurityImpersonation, windows.TokenPrimary, &primary); err != nil {
		return 0, 0, err
	}
	defer primary.Close()

	var env *uint16
	if err := windows.CreateEnvironmentBlock(&env, primary, false); err != nil {
		env = nil
	} else {
		defer windows.DestroyEnvironmentBlock(env)
	}
	cmd, err := windows.UTF16FromString(fmt.Sprintf(`"%s" --tray --port %d`, exe, port))
	if err != nil {
		return 0, 0, err
	}
	desktopPtr, err := windows.UTF16PtrFromString(`winsta0\default`)
	if err != nil {
		return 0, 0, err
	}
	inRead, inWrite, err := sessionPipe(true)
	if err != nil {
		return 0, 0, err
	}
	defer windows.CloseHandle(inRead)
	attrs, err := windows.NewProcThreadAttributeList(1)
	if err != nil {
		windows.CloseHandle(inWrite)
		return 0, 0, err
	}
	defer attrs.Delete()
	handles := []windows.Handle{inRead}
	if err := attrs.Update(windows.PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
		unsafe.Pointer(&handles[0]), unsafe.Sizeof(handles[0])); err != nil {
		windows.CloseHandle(inWrite)
		return 0, 0, err
	}
	si := &windows.StartupInfoEx{
		StartupInfo: windows.StartupInfo{
			Desktop:  desktopPtr,
			Flags:    windows.STARTF_USESTDHANDLES,
			StdInput: inRead,
		},
		ProcThreadAttributeList: attrs.List(),
	}
	si.Cb = uint32(unsafe.Sizeof(*si))
	var pi windows.ProcessInformation
	if err := windows.CreateProcessAsUser(primary, nil, &cmd[0], nil, nil, true,
		windows.CREATE_UNICODE_ENVIRONMENT|windows.EXTENDED_STARTUPINFO_PRESENT,
		env, nil, &si.StartupInfo, &pi); err != nil {
		windows.CloseHandle(inWrite)
		return 0, 0, err
	}
	_ = windows.CloseHandle(pi.Thread)
	_ = windows.CloseHandle(pi.Process)
	return pi.ProcessId, inWrite, nil
}

// sessionPipe makes an anonymous pipe whose child end (the read end for
// stdin, the write end for output) is inheritable and whose service end
// is not.
func sessionPipe(childReads bool) (read, write windows.Handle, err error) {
	sa := &windows.SecurityAttributes{InheritHandle: 1}
	sa.Length = uint32(unsafe.Sizeof(*sa))
	if err := windows.CreatePipe(&read, &write, sa, 0); err != nil {
		return 0, 0, err
	}
	keep := write
	if !childReads {
		keep = read
	}
	if err := windows.SetHandleInformation(keep, windows.HANDLE_FLAG_INHERIT, 0); err != nil {
		windows.CloseHandle(read)
		windows.CloseHandle(write)
		return 0, 0, err
	}
	return read, write, nil
}

// copySessionLog writes the screen session's output into the host log
// until the session exits.
func copySessionLog(r *os.File) {
	defer r.Close()
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		line := scanner.Text()
		// Session lines already carry a timestamp.
		if i := strings.IndexByte(line, ' '); i > 0 && strings.Contains(line[:i], "T") {
			line = line[i+1:]
		}
		logf("session: %s", line)
	}
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
