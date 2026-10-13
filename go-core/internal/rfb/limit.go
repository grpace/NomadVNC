package rfb

import (
	"net"
	"sync"
	"time"
)

const (
	// freeFailures is how many wrong passwords in a row cost nothing.
	freeFailures = 3
	// maxAuthDelay caps the wait before each further attempt.
	maxAuthDelay = 30 * time.Second
	// failureMemory is how long a run of failures is remembered.
	failureMemory = 15 * time.Minute
	// HandshakeTimeout bounds the time from connect to a finished sign-in.
	HandshakeTimeout = 30 * time.Second
)

// authLimiter slows password guessing. VNC passwords are at most eight
// characters, so after a few wrong ones from an address each further
// attempt waits longer, up to maxAuthDelay, and attempts from that address
// take turns. Behind NomadVNC Host's service every viewer arrives from
// loopback, so the limit applies to all of them together.
type authLimiter struct {
	mu    sync.Mutex
	hosts map[string]*authHost
}

type authHost struct {
	turn     sync.Mutex // one delayed attempt at a time
	failures int
	last     time.Time
}

func hostOf(addr net.Addr) string {
	if tcp, ok := addr.(*net.TCPAddr); ok {
		return tcp.IP.String()
	}
	if addr == nil {
		return ""
	}
	return addr.String()
}

func (l *authLimiter) host(key string) *authHost {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.hosts == nil {
		l.hosts = map[string]*authHost{}
	}
	h := l.hosts[key]
	if h == nil {
		h = &authHost{}
		l.hosts[key] = h
	}
	return h
}

// delay is how long the next attempt from h must wait.
func (l *authLimiter) delay(h *authHost) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	if time.Since(h.last) > failureMemory {
		h.failures = 0
	}
	if h.failures < freeFailures {
		return 0
	}
	d := time.Second << min(h.failures-freeFailures, 5)
	return min(d, maxAuthDelay)
}

func (l *authLimiter) result(h *authHost, ok bool) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if ok {
		h.failures = 0
		return
	}
	h.failures++
	h.last = time.Now()
}
