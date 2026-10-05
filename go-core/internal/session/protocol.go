package session

import "encoding/json"

type Request struct {
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params,omitempty"`
}

type Response struct {
	ID     string `json:"id,omitempty"`
	OK     bool   `json:"ok"`
	Result any    `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
	Event  *Event `json:"event,omitempty"`
}

type Event struct {
	Type         string        `json:"type"`
	Scope        string        `json:"scope,omitempty"`
	SessionID    string        `json:"sessionId,omitempty"`
	State        string        `json:"state,omitempty"`
	Message      string        `json:"message,omitempty"`
	AuthURL      string        `json:"authUrl,omitempty"`
	TailnetState *TailnetState `json:"statePayload,omitempty"`
}

type TailnetState struct {
	LoggedIn       bool   `json:"loggedIn"`
	InMapPoll      bool   `json:"inMapPoll"`
	BackendState   string `json:"backendState,omitempty"`
	AuthURL        string `json:"authUrl,omitempty"`
	SelfDeviceName string `json:"selfDeviceName,omitempty"`
	TailscaleIPv4  string `json:"tailscaleIpv4,omitempty"`
	TailscaleIPv6  string `json:"tailscaleIpv6,omitempty"`
	// KeyExpiry is RFC3339: when the node key expired or will expire.
	// Absent when the control plane reports none (e.g. non-expiring keys).
	KeyExpiry string `json:"keyExpiry,omitempty"`
}

type PeerDevice struct {
	StableID    string   `json:"stableId"`
	DisplayName string   `json:"displayName"`
	DNSName     string   `json:"dnsName,omitempty"`
	TailnetIPs  []string `json:"tailnetIps"`
	Online      bool     `json:"online"`
	OS          string   `json:"os,omitempty"`
	LastSeen    string   `json:"lastSeen,omitempty"`
}

type StartSessionParams struct {
	Host               string `json:"host"`
	Port               int    `json:"port"`
	SessionToken       string `json:"sessionToken"`
	PreferredLocalPort int    `json:"preferredLocalPort,omitempty"`
	// Direct marks a user-typed manual host/IP (not a tailnet device pick).
	// The tailnet-login gate is skipped and the target is dialed via the OS
	// network when the tailnet isn't up — the local-first path.
	Direct bool `json:"direct,omitempty"`
}

type StopSessionParams struct {
	SessionID string `json:"sessionId"`
}

type PeerPathParams struct {
	Host string `json:"host"`
}

// HostnameResult is the tailnet name now configured for this device.
// Applied is true when a running node was renamed immediately. False
// means the name is stored and used the next time Tailscale starts.
// Setting the name never starts Tailscale.
type HostnameResult struct {
	Hostname string `json:"hostname"`
	Applied  bool   `json:"applied"`
}

// PeerPath is the UI-facing verdict on how tailnet traffic reaches a host:
// a direct UDP path, a DERP-relayed path, or unknown. Latency comes from a
// best-effort disco ping; it is absent when only status data was available.
type PeerPath struct {
	Host        string `json:"host"`
	Found       bool   `json:"found"`
	Path        string `json:"path"`
	LatencyMs   *int64 `json:"latencyMs,omitempty"`
	RelayRegion string `json:"relayRegion,omitempty"`
	Endpoint    string `json:"endpoint,omitempty"`
}

type StartSessionResult struct {
	SessionID   string `json:"sessionId"`
	WSURL       string `json:"wsUrl"`
	HTTPBaseURL string `json:"httpBaseUrl,omitempty"`
}
