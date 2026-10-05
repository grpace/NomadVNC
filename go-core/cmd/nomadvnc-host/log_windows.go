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

func logf(format string, args ...any) {
	line := time.Now().Format(time.RFC3339) + " " + fmt.Sprintf(format, args...) + "\n"
	dir := dataDir()
	_ = os.MkdirAll(dir, 0o755)
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
	return hostnet.SignIn(ctx, hostcore.TailscaleDir(dataDir()), deviceHostname(), func(string) {
		fmt.Println("Tailscale asked for approval.")
		logf("tailscale asked for approval")
	}, func(status string) {
		fmt.Println(status)
		logf("tailscale: %s", status)
	}, nil)
}
