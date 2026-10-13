package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"os"
	"time"

	"github.com/nomadvnc/nomadvnc/go-core/internal/hostcore"
	"github.com/nomadvnc/nomadvnc/go-core/internal/hostnet"
)

// redactWriter drops log lines that contain a URL. Tailscale's own logger
// prints the interactive approval address, and that address must not be
// stored.
type redactWriter struct{ dst io.Writer }

func (w redactWriter) Write(p []byte) (int, error) {
	if bytes.Contains(p, []byte("://")) {
		return len(p), nil
	}
	return w.dst.Write(p)
}

func init() {
	log.SetOutput(redactWriter{dst: os.Stderr})
}

// logToStderr is set in the screen session. The service reads its stderr
// into the log, so one process writes the file.
var logToStderr bool

func logf(format string, args ...any) {
	line := time.Now().Format(time.RFC3339) + " " + fmt.Sprintf(format, args...) + "\n"
	if logToStderr {
		_, _ = os.Stderr.WriteString(line)
		return
	}
	dir := dataDir()
	if _, err := os.Stat(dir); err != nil {
		// Only setup and the service create the folder, so it starts out
		// owned by Administrators rather than whoever ran the exe first.
		if !isPrivileged() {
			return
		}
		_ = os.MkdirAll(dir, 0o700)
	}
	path := hostcore.LogPath(dir)
	info, err := os.Stat(path)
	if err == nil && info.Size() > 1<<20 {
		_ = os.Remove(path)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	_, _ = file.WriteString(line)
	_ = file.Close()
}

func dataDir() string {
	return hostcore.DataDir(os.Getenv("ProgramData"))
}

func installedExe() string {
	return hostcore.InstallDir(os.Getenv("ProgramFiles")) + `\nomadvnc-host.exe`
}

func machineNamePath() string {
	return dataDir() + `\machine-name.txt`
}

func saveMachineName(raw string) error {
	name, err := hostcore.NormalizeMachineName(raw)
	if err != nil {
		return err
	}
	if name == "" {
		_ = os.Remove(machineNamePath())
		return nil
	}
	if err := os.MkdirAll(dataDir(), 0o755); err != nil {
		return err
	}
	return os.WriteFile(machineNamePath(), []byte(name), 0o644)
}

// savedPort is the port the host listens on.
func savedPort() int {
	text, err := os.ReadFile(hostcore.PortPath(dataDir()))
	if err != nil {
		return hostcore.DefaultPort
	}
	port, err := hostcore.ParsePort(string(text))
	if err != nil {
		return hostcore.DefaultPort
	}
	return port
}

func savePort(port int) error {
	if err := os.MkdirAll(dataDir(), 0o755); err != nil {
		return err
	}
	return os.WriteFile(hostcore.PortPath(dataDir()), []byte(fmt.Sprint(port)), 0o644)
}

// trayWanted reports whether to show the icon in the system tray.
func trayWanted() bool {
	_, err := os.Stat(hostcore.NoTrayPath(dataDir()))
	return err != nil
}

func saveTrayWanted(wanted bool) error {
	path := hostcore.NoTrayPath(dataDir())
	if wanted {
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	return os.WriteFile(path, nil, 0o644)
}

func savedMachineName() string {
	text, err := os.ReadFile(machineNamePath())
	if err != nil {
		return ""
	}
	name, err := hostcore.NormalizeMachineName(string(text))
	if err != nil {
		return ""
	}
	return name
}

func deviceHostname() string {
	return hostnet.DeviceHostname(savedMachineName())
}

func desktopTitle() string {
	if name := savedMachineName(); name != "" {
		return name
	}
	return "NomadVNC Host"
}

func signInTailscale() error {
	stopService()
	defer func() { _ = startService() }()
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	expiry, err := hostnet.SignIn(ctx, hostcore.TailscaleDir(dataDir()), deviceHostname(), func(string) {
		fmt.Println("Tailscale asked for approval.")
		logf("tailscale asked for approval")
	}, func(status string) {
		fmt.Println(status)
		logf("tailscale: %s", status)
	})
	if err != nil {
		return err
	}
	if !expiry.IsZero() {
		fmt.Printf("Key expiry is on: this PC drops off the tailnet on %s. Turn it off on the Machines page of the Tailscale admin console.\n", expiry.Format("2 January 2006"))
	}
	return nil
}
