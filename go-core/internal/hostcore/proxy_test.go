package hostcore

import (
	"context"
	"io"
	"net"
	"testing"
	"time"
)

func TestProxyCopiesBytes(t *testing.T) {
	backend, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	go func() {
		conn, err := backend.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_, _ = io.Copy(conn, conn)
	}()

	front, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer front.Close()
	go Proxy(t.Context(), front, func(context.Context) (net.Conn, error) {
		return net.Dial("tcp", backend.Addr().String())
	})

	conn, err := net.Dial("tcp", front.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("ping")); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 4)
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != "ping" {
		t.Fatalf("proxied %q", buf)
	}
}

func TestProxyClosesSessionsWhenItStops(t *testing.T) {
	upstream, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer upstream.Close()
	go func() {
		for {
			c, err := upstream.Accept()
			if err != nil {
				return
			}
			go func() { _, _ = io.Copy(io.Discard, c) }()
		}
	}()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		_ = Proxy(context.Background(), ln, func(ctx context.Context) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "tcp", upstream.Addr().String())
		})
		close(done)
	}()
	client, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if _, err := client.Write([]byte("hi")); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	_ = ln.Close()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("Proxy kept waiting on an open session after its listener closed")
	}
	_ = client.SetReadDeadline(time.Now().Add(time.Second))
	if _, err := client.Read(make([]byte, 1)); err == nil {
		t.Fatal("session still open")
	}
}

func TestProxyLimitsConnections(t *testing.T) {
	backend, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	go func() {
		for {
			conn, err := backend.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
			}()
		}
	}()
	front, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer front.Close()
	go Proxy(t.Context(), front, func(context.Context) (net.Conn, error) {
		return net.Dial("tcp", backend.Addr().String())
	})

	echoes := func(conn net.Conn) bool {
		_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
		if _, err := conn.Write([]byte("x")); err != nil {
			return false
		}
		_, err := io.ReadFull(conn, make([]byte, 1))
		return err == nil
	}
	var held []net.Conn
	defer func() {
		for _, c := range held {
			c.Close()
		}
	}()
	for i := 0; i < MaxProxyConns; i++ {
		conn, err := net.Dial("tcp", front.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		held = append(held, conn)
		if !echoes(conn) {
			t.Fatalf("connection %d of %d was not carried", i+1, MaxProxyConns)
		}
	}
	extra, err := net.Dial("tcp", front.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer extra.Close()
	if echoes(extra) {
		t.Fatal("a connection past the limit was carried")
	}

	// Closing one frees its place.
	held[0].Close()
	deadline := time.Now().Add(3 * time.Second)
	for {
		conn, err := net.Dial("tcp", front.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		ok := echoes(conn)
		conn.Close()
		if ok {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("no place freed after a connection closed")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestProxyFreesPlaceWhenDialFails(t *testing.T) {
	front, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer front.Close()
	backend, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer backend.Close()
	go func() {
		for {
			conn, err := backend.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
			}()
		}
	}()
	gate := make(chan struct{})
	go Proxy(t.Context(), front, func(context.Context) (net.Conn, error) {
		select {
		case <-gate:
			return net.Dial("tcp", backend.Addr().String())
		default:
			return nil, io.ErrClosedPipe
		}
	})
	// More failed dials than there are places.
	for i := 0; i < MaxProxyConns*2; i++ {
		conn, err := net.Dial("tcp", front.Addr().String())
		if err != nil {
			t.Fatal(err)
		}
		_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
		_, _ = io.ReadFull(conn, make([]byte, 1)) // closed by the proxy
		conn.Close()
	}
	close(gate)
	conn, err := net.Dial("tcp", front.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err := conn.Write([]byte("x")); err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadFull(conn, make([]byte, 1)); err != nil {
		t.Fatalf("no place left after failed dials: %v", err)
	}
}
