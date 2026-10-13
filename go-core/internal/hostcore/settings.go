package hostcore

import (
	"errors"
	"fmt"
	"path/filepath"
	"strconv"
	"strings"
)

// DefaultPort is the VNC port, used unless the person chose another.
const DefaultPort = 5900

// helperPort is the loopback port in HelperListen, which the service
// can't also listen on.
const helperPort = 5910

// PortPath is where a chosen port is saved.
func PortPath(dataDir string) string {
	return filepath.Join(dataDir, "port.txt")
}

// NoTrayPath marks an install that asked for no icon in the system tray.
func NoTrayPath(dataDir string) string {
	return filepath.Join(dataDir, "no-tray")
}

// ParsePort reads a port a person typed. Empty means DefaultPort.
func ParsePort(raw string) (int, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return DefaultPort, nil
	}
	port, err := strconv.Atoi(raw)
	if err != nil || port < 1 || port > 65535 {
		return 0, errors.New("use a port number from 1 to 65535")
	}
	if port == helperPort {
		return 0, fmt.Errorf("port %d is used by NomadVNC Host itself; choose another", helperPort)
	}
	return port, nil
}

// ListenAddr is the address to listen on for port, on every interface.
func ListenAddr(port int) string {
	return fmt.Sprintf(":%d", port)
}
