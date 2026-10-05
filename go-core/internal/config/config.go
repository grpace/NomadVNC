package config

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

const tailscaleHostnamePrefix = "NomadVNC-"

type EngineConfig struct {
	AppName string
	// Hostname is the tailnet name in use. A chosen name replaces it;
	// an empty choice falls back to DefaultHostname.
	Hostname string
	// DefaultHostname is the automatic name (NomadVNC- plus a device
	// name). Clearing the setting returns to this.
	DefaultHostname string
	StateDir        string
	// AuthKey, when set, logs the node in non-interactively (headless
	// setups). Empty keeps the default interactive browser login.
	AuthKey string
	// ControlURL overrides the Tailscale coordination server (e.g. a
	// self-hosted Headscale instance). Empty keeps the default
	// Tailscale control plane.
	ControlURL string
}

// Default returns the baseline config. The state dir is created lazily
// when the tailnet node first starts — never here, so callers that
// override StateDir (the desktop app, the mobile bindings) don't leave a
// stray ./state directory in the working directory.
func Default() EngineConfig {
	name := DefaultTailscaleHostname()
	return EngineConfig{
		AppName:         "nomadvnc",
		Hostname:        name,
		DefaultHostname: name,
		StateDir:        filepath.Join(".", "state"),
	}
}

// NormalizeChosenHostname turns a name typed in Settings into a tailnet
// hostname. An empty name is valid and means "use the automatic name."
func NormalizeChosenHostname(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	name := sanitizeTailscaleHostSuffix(raw)
	if name == "" {
		return "", errors.New("use letters and numbers for the name")
	}
	if len(name) > 63 {
		name = strings.Trim(name[:63], "-")
	}
	if name == "" {
		return "", errors.New("use letters and numbers for the name")
	}
	return name, nil
}

// AutomaticHostname is NomadVNC- plus a DNS-safe form of the device's own
// name. "localhost" (what iOS reports from the sandbox) is not used.
func AutomaticHostname(deviceName string) string {
	suffix := sanitizeTailscaleHostSuffix(deviceName)
	if isUselessHostSuffix(suffix) {
		return DefaultTailscaleHostname()
	}
	return prefixedHostname(suffix)
}

// DefaultTailscaleHostname is the tsnet machine name shown on the tailnet:
// NomadVNC- plus a DNS-safe form of the OS hostname (Tailscale labels are
// lowercase letters, digits, and hyphens; total length capped for a single label).
func DefaultTailscaleHostname() string {
	host, err := os.Hostname()
	if err != nil {
		return tailscaleHostnamePrefix + "device"
	}

	suffix := sanitizeTailscaleHostSuffix(host)
	if isUselessHostSuffix(suffix) {
		suffix = "device"
	}
	return prefixedHostname(suffix)
}

func isUselessHostSuffix(suffix string) bool {
	switch suffix {
	case "", "localhost", "localhost-localdomain":
		return true
	default:
		return false
	}
}

func prefixedHostname(suffix string) string {
	full := tailscaleHostnamePrefix + suffix
	if len(full) <= 63 {
		return full
	}
	maxSuffix := 63 - len(tailscaleHostnamePrefix)
	if maxSuffix < 1 {
		return strings.TrimRight(tailscaleHostnamePrefix, "-")
	}
	if len(suffix) > maxSuffix {
		suffix = suffix[:maxSuffix]
	}
	return tailscaleHostnamePrefix + strings.TrimRight(suffix, "-")
}

func sanitizeTailscaleHostSuffix(host string) string {
	host = strings.TrimSpace(strings.ToLower(host))
	var b strings.Builder
	lastWasSep := true
	for _, r := range host {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			lastWasSep = false
			continue
		}
		if !lastWasSep {
			b.WriteByte('-')
			lastWasSep = true
		}
	}
	return strings.Trim(b.String(), "-")
}
