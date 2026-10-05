package hostcore

import (
	"errors"
	"strings"
	"unicode"
)

// NormalizeMachineName turns a name a person typed into the hostname other
// NomadVNC devices will see. An empty name is valid and means "use the
// Windows computer name."
func NormalizeMachineName(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}

	var b strings.Builder
	lastHyphen := true
	for _, r := range strings.ToLower(raw) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
			lastHyphen = false
		case unicode.IsSpace(r) || r == '-' || r == '_':
			if !lastHyphen && b.Len() > 0 {
				b.WriteByte('-')
				lastHyphen = true
			}
		}
	}
	name := strings.Trim(b.String(), "-")
	if name == "" {
		return "", errors.New("use letters and numbers for the name")
	}
	if len(name) > 32 {
		name = strings.Trim(name[:32], "-")
	}
	if name == "" {
		return "", errors.New("use letters and numbers for the name")
	}
	return name, nil
}
