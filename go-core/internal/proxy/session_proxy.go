package proxy

import (
	"context"
	"crypto/subtle"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

type DialFunc func(ctx context.Context, network, address string) (net.Conn, error)

type SessionProxy struct {
	sessionID string
	token     string
	target    string
	dial      DialFunc

	server   *http.Server
	listener net.Listener
	mu       sync.Mutex
	// active holds the bridged connections of in-flight viewer sessions.
	// http.Server.Shutdown ignores hijacked (WebSocket) connections, so
	// Close tears these down itself — otherwise "disconnect" would leave
	// the VNC TCP stream open until the viewer happened to hang up.
	active map[io.Closer]struct{}
	closed bool
}

func NewSessionProxy(sessionID, token, listenAddr, target string, dial DialFunc) *SessionProxy {
	mux := http.NewServeMux()
	proxy := &SessionProxy{
		sessionID: sessionID,
		token:     token,
		target:    target,
		dial:      dial,
		active:    make(map[io.Closer]struct{}),
	}

	mux.HandleFunc("/vnc", proxy.handleViewer)
	proxy.server = &http.Server{
		Addr:              listenAddr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	return proxy
}

func (p *SessionProxy) Start() (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.listener != nil {
		return "", errors.New("session proxy already started")
	}

	listener, err := net.Listen("tcp", p.server.Addr)
	if err != nil {
		return "", err
	}

	p.listener = listener
	go func() {
		_ = p.server.Serve(listener)
	}()

	return fmt.Sprintf("ws://%s/vnc?token=%s", listener.Addr().String(), p.token), nil
}

func (p *SessionProxy) Close(ctx context.Context) error {
	p.mu.Lock()
	if p.listener == nil {
		p.mu.Unlock()
		return nil
	}
	p.listener = nil
	p.closed = true
	conns := make([]io.Closer, 0, len(p.active))
	for conn := range p.active {
		conns = append(conns, conn)
	}
	p.active = make(map[io.Closer]struct{})
	p.mu.Unlock()

	err := p.server.Shutdown(ctx)
	for _, conn := range conns {
		_ = conn.Close()
	}
	return err
}

// track registers a bridged connection for teardown on Close. It reports
// false (and the caller must bail) when the proxy is already closing.
func (p *SessionProxy) track(conn io.Closer) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return false
	}
	p.active[conn] = struct{}{}
	return true
}

func (p *SessionProxy) untrack(conn io.Closer) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.active, conn)
}

// ActiveConnections reports how many bridged connections are live.
func (p *SessionProxy) ActiveConnections() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.active)
}

func (p *SessionProxy) handleViewer(writer http.ResponseWriter, request *http.Request) {
	// Constant-time compare: the token is the only thing standing between
	// any local process (or web page) and the remote desktop.
	if subtle.ConstantTimeCompare([]byte(request.URL.Query().Get("token")), []byte(p.token)) != 1 {
		http.Error(writer, "invalid token", http.StatusUnauthorized)
		return
	}

	upgrader := websocket.Upgrader{
		CheckOrigin: func(*http.Request) bool { return true },
	}

	wsConn, err := upgrader.Upgrade(writer, request, nil)
	if err != nil {
		return
	}
	defer wsConn.Close()
	if !p.track(wsConn) {
		return
	}
	defer p.untrack(wsConn)

	tcpConn, err := p.dial(request.Context(), "tcp", p.target)
	if err != nil {
		_ = wsConn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseInternalServerErr, err.Error()))
		return
	}
	defer tcpConn.Close()
	if !p.track(tcpConn) {
		return
	}
	defer p.untrack(tcpConn)

	errCh := make(chan error, 2)

	go func() {
		for {
			messageType, payload, readErr := wsConn.ReadMessage()
			if readErr != nil {
				errCh <- readErr
				return
			}
			if messageType != websocket.BinaryMessage && messageType != websocket.TextMessage {
				continue
			}
			if _, writeErr := tcpConn.Write(payload); writeErr != nil {
				errCh <- writeErr
				return
			}
		}
	}()

	go func() {
		buffer := make([]byte, 32*1024)
		for {
			readCount, readErr := tcpConn.Read(buffer)
			if readCount > 0 {
				if writeErr := wsConn.WriteMessage(websocket.BinaryMessage, buffer[:readCount]); writeErr != nil {
					errCh <- writeErr
					return
				}
			}
			if readErr != nil {
				if errors.Is(readErr, io.EOF) {
					errCh <- nil
				} else {
					errCh <- readErr
				}
				return
			}
		}
	}()

	if proxyErr := <-errCh; proxyErr != nil && !websocket.IsCloseError(proxyErr, websocket.CloseNormalClosure, websocket.CloseGoingAway) {
		_ = wsConn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseInternalServerErr, proxyErr.Error()))
	}
}
