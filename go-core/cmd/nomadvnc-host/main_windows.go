package main

import (
	"context"
	"fmt"
	"os"
	"runtime/debug"

	"github.com/nomadvnc/nomadvnc/go-core/internal/hostcore"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

// version is the release this exe was built as. scripts/build-host.mjs
// sets it from package.json; a plain `go build` leaves "dev".
var version = "dev"

var procAttachConsole = windows.NewLazySystemDLL("kernel32.dll").NewProc("AttachConsole")

// attachParentConsole lets a command typed at a prompt print there. The
// exe is built as a windowed program so that no console window opens
// beside the setup window, which also means it starts with no console of
// its own. Output already sent to a file or pipe is left alone.
func attachParentConsole() {
	if h, err := windows.GetStdHandle(windows.STD_OUTPUT_HANDLE); err == nil && h != 0 && h != windows.InvalidHandle {
		return
	}
	const attachParentProcess = ^uint32(0)
	if r, _, _ := procAttachConsole.Call(uintptr(attachParentProcess)); r == 0 {
		return
	}
	if out, err := os.OpenFile("CONOUT$", os.O_WRONLY, 0); err == nil {
		os.Stdout, os.Stderr = out, out
	}
}

// keepCrashReports sends what Go prints when the program dies to
// crash.log in the data folder. A windowed program has no console, so
// without this a crash leaves no trace at all. The screen session's
// output already goes to the service's log.
func keepCrashReports() {
	if logToStderr || !isPrivileged() {
		return
	}
	if err := os.MkdirAll(dataDir(), 0o700); err != nil {
		return
	}
	file, err := os.OpenFile(dataDir()+`\crash.log`, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return
	}
	if info, err := file.Stat(); err == nil && info.Size() > 1<<20 {
		_ = file.Truncate(0)
	}
	// The runtime keeps its own copy of the handle.
	_ = debug.SetCrashOutput(file, debug.CrashOptions{})
	_ = file.Close()
}

func main() {
	// Windows won't delete a folder that is some process's working
	// folder. Started from its shortcut, this one's would be the program
	// folder, which an uninstall then couldn't remove.
	if dir, err := windows.GetSystemDirectory(); err == nil {
		_ = os.Chdir(dir)
	}
	if hasFlag("--install") || hasFlag("--uninstall") || hasFlag("--sign-in") || hasFlag("--version") {
		attachParentConsole()
	}
	if hasFlag("--version") {
		fmt.Println("NomadVNC Host", version)
		return
	}
	if hasFlag("--tray") {
		runTray()
		return
	}
	logToStderr = hasFlag("--session")
	keepCrashReports()
	isService, err := svc.IsWindowsService()
	logf("start version=%s service=%v elevated=%v privileged=%v err=%v", version, isService, isElevated(), isPrivileged(), err)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if isService {
		runWindowsService()
		return
	}
	if hasFlag("--session") {
		if err := runSession(context.Background()); err != nil {
			logf("stopped: %v", err)
			os.Exit(1)
		}
		return
	}
	if !isPrivileged() {
		logf("requesting administrator approval")
		if err := relaunchElevated(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if hasFlag("--install") {
		if name := flagValue("--name"); name != "" {
			if err := saveMachineName(name); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
		}
		password, err := passwordFromArgs(os.Args[1:])
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		// Left out, the port stays as it was: a rerun that changes only
		// the password must not move the host back to 5900.
		port := savedPort()
		if raw := flagValue("--port"); raw != "" {
			if port, err = hostcore.ParsePort(raw); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
		}
		if err := installHost(password, port, !hasFlag("--no-tray")); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println("NomadVNC Host is installed and running.")
		return
	}
	if hasFlag("--uninstall") {
		// --ask is how Installed apps in Windows Settings runs this.
		// Windows has asked whether to uninstall; what it can't ask is
		// whether the saved password and Tailscale sign-in go too.
		asking := hasFlag("--ask")
		deleteData := hasFlag("--delete-data")
		if asking {
			deleteData = ask("Uninstall NomadVNC Host", "Also remove the saved VNC password and Tailscale sign-in?")
		}
		if err := uninstallHost(deleteData); err != nil {
			if asking {
				tell("Uninstall NomadVNC Host", err.Error())
			}
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if asking {
			tell("Uninstall NomadVNC Host", "NomadVNC Host was removed.")
		}
		fmt.Println("NomadVNC Host was removed.")
		return
	}
	if hasFlag("--sign-in") {
		if err := signInTailscale(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	runWizard()
}
