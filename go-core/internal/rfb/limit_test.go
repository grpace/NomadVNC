package rfb

import (
	"errors"
	"net"
	"testing"
	"time"
)

func TestAuthLimiterBacksOff(t *testing.T) {
	var l authLimiter
	h := l.host("10.0.0.1")
	for i := 0; i < freeFailures; i++ {
		if d := l.delay(h); d != 0 {
			t.Fatalf("attempt %d delayed %s", i+1, d)
		}
		l.result(h, false)
	}
	want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, maxAuthDelay, maxAuthDelay}
	for i, w := range want {
		if d := l.delay(h); d != w {
			t.Fatalf("failure %d: delay %s, want %s", freeFailures+i, d, w)
		}
		l.result(h, false)
	}
	l.result(h, true)
	if d := l.delay(h); d != 0 {
		t.Fatalf("after a success, delay %s", d)
	}
	l.result(h, false)
	h.last = time.Now().Add(-failureMemory - time.Minute)
	for i := 0; i < 5; i++ {
		l.result(h, false)
	}
	h.last = time.Now().Add(-failureMemory - time.Minute)
	if d := l.delay(h); d != 0 {
		t.Fatalf("old failures still count: %s", d)
	}
}

func TestWrongPasswordsSlowDown(t *testing.T) {
	server := &Server{Password: "secret", Capture: func() (Frame, error) { return redFrame(), nil }}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go server.Serve(t.Context(), ln)
	try := func(password string) (time.Duration, error) {
		conn, err := net.Dial("tcp", ln.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
		start := time.Now()
		err = clientHandshake(conn, password)
		return time.Since(start), err
	}
	for i := 0; i < freeFailures; i++ {
		if d, err := try("nope"); !errors.Is(err, ErrAuth) || d > 500*time.Millisecond {
			t.Fatalf("free attempt %d: %s, %v", i+1, d, err)
		}
	}
	if d, err := try("nope"); !errors.Is(err, ErrAuth) || d < 900*time.Millisecond {
		t.Fatalf("4th wrong password answered after %s (%v); want about 1s", d, err)
	}
	// The right password still works, after its own wait.
	if _, err := try("secret"); err != nil {
		t.Fatalf("right password: %v", err)
	}
	if d, err := try("secret"); err != nil || d > 500*time.Millisecond {
		t.Fatalf("after a success: %s, %v", d, err)
	}
}
