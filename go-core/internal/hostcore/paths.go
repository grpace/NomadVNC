package hostcore

import (
	"errors"
	"path/filepath"
	"strings"
)

const (
	// ServiceName is the Windows service that starts at boot.
	ServiceName = "NomadVNCHost"
	// FirewallRule is the inbound rule for the VNC port.
	FirewallRule = "NomadVNC Host"
	// HelperListen is the loopback address the screen-sharing process binds.
	// The service proxies the public port to it. Loopback is not the LAN.
	HelperListen = "127.0.0.1:5910"
	// PublicListen is the port NomadVNC connects to.
	PublicListen = ":5900"
)

// DataDir is the per-machine configuration directory.
func DataDir(programData string) string {
	if strings.TrimSpace(programData) == "" {
		programData = `C:\ProgramData`
	}
	return filepath.Join(programData, "NomadVNC Host")
}

// InstallDir is where the host executable is copied.
func InstallDir(programFiles string) string {
	if strings.TrimSpace(programFiles) == "" {
		programFiles = `C:\Program Files`
	}
	return filepath.Join(programFiles, "NomadVNC Host")
}

func PasswordPath(dataDir string) string {
	return filepath.Join(dataDir, "vnc-password.bin")
}

func TailscaleDir(dataDir string) string {
	return filepath.Join(dataDir, "tsnet")
}

func LogPath(dataDir string) string {
	return filepath.Join(dataDir, "host.log")
}

// ValidatePassword enforces the 8-byte VNC authentication key length.
func ValidatePassword(password string) error {
	if strings.TrimSpace(password) == "" {
		return errors.New("enter a password")
	}
	if len(password) > 8 {
		return errors.New("use 8 characters or fewer")
	}
	return nil
}
