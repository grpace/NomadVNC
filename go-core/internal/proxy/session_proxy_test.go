package proxy

import (
	"context"
	"io"
	"net"
	"net/http"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestSessionProxyBridgesWebSocketToTCP(t *testing.T) {
	tcpListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer tcpListener.Close()

	go func() {
		conn, acceptErr := tcpListener.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()

		payload := make([]byte, 4)
		_, _ = io.ReadFull(conn, payload)
		_, _ = conn.Write([]byte("pong"))
	}()

	proxy := NewSessionProxy(
		"session-1",
		"token-1",
		"127.0.0.1:0",
		tcpListener.Addr().String(),
		func(ctx context.Context, network, address string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, address)
		},
	)

	wsURL, err := proxy.Start()
	if err != nil {
		t.Fatalf("start proxy: %v", err)
	}
	defer proxy.Close(context.Background())

	wsConn, _, err := websocket.DefaultDialer.Dial(wsURL, http.Header{})
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}
	defer wsConn.Close()

	if err := wsConn.WriteMessage(websocket.BinaryMessage, []byte("ping")); err != nil {
		t.Fatalf("write websocket message: %v", err)
	}

	_ = wsConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, payload, err := wsConn.ReadMessage()
	if err != nil {
		t.Fatalf("read websocket message: %v", err)
	}

	if string(payload) != "pong" {
		t.Fatalf("unexpected payload: %q", string(payload))
	}
}

func TestSessionProxyRejectsWrongToken(t *testing.T) {
	proxy := NewSessionProxy(
		"session-2",
		"token-2",
		"127.0.0.1:0",
		"127.0.0.1:5900",
		func(ctx context.Context, network, address string) (net.Conn, error) {
			return nil, context.Canceled
		},
	)

	wsURL, err := proxy.Start()
	if err != nil {
		t.Fatalf("start proxy: %v", err)
	}
	defer proxy.Close(context.Background())

	wsURL = wsURL[:len(wsURL)-len("token-2")] + "bad-token"
	_, response, err := websocket.DefaultDialer.Dial(wsURL, http.Header{})
	if err == nil {
		t.Fatal("expected unauthorized error")
	}
	if response == nil || response.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected unauthorized response, got %#v", response)
	}
}

func TestSessionProxyCloseTearsDownLiveBridges(t *testing.T) {
	tcpListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer tcpListener.Close()

	remoteClosed := make(chan struct{})
	go func() {
		conn, acceptErr := tcpListener.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()
		// Block until the proxy hangs up on the "VNC server".
		_, _ = io.Copy(io.Discard, conn)
		close(remoteClosed)
	}()

	proxy := NewSessionProxy(
		"session-3",
		"token-3",
		"127.0.0.1:0",
		tcpListener.Addr().String(),
		func(ctx context.Context, network, address string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, network, address)
		},
	)
	wsURL, err := proxy.Start()
	if err != nil {
		t.Fatalf("start proxy: %v", err)
	}

	wsConn, _, err := websocket.DefaultDialer.Dial(wsURL, http.Header{})
	if err != nil {
		t.Fatalf("dial websocket: %v", err)
	}
	defer wsConn.Close()

	deadline := time.Now().Add(2 * time.Second)
	for proxy.ActiveConnections() < 2 {
		if time.Now().After(deadline) {
			t.Fatalf("bridge never came up (active=%d)", proxy.ActiveConnections())
		}
		time.Sleep(10 * time.Millisecond)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := proxy.Close(ctx); err != nil {
		t.Fatalf("close: %v", err)
	}

	select {
	case <-remoteClosed:
	case <-time.After(2 * time.Second):
		t.Fatal("Close left the VNC TCP stream open")
	}

	_ = wsConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := wsConn.ReadMessage(); err == nil {
		t.Fatal("expected the viewer WebSocket to be closed")
	}
}
