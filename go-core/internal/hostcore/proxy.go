package hostcore

import (
	"context"
	"errors"
	"io"
	"net"
	"sync"
	"time"
)

// MaxProxyConns is how many connections one Proxy carries at a time. A
// screen has a handful of viewers; the cap keeps a flood of connections
// from using up the PC's memory and sockets.
const MaxProxyConns = 32

// Proxy accepts connections on ln and copies bytes to a connection from dial.
// It returns when ctx is cancelled or ln is closed, after closing the
// connections it is carrying: a listener closed because its network went
// away must not leave sessions hanging on it. Connections past
// MaxProxyConns are closed at once.
func Proxy(ctx context.Context, ln net.Listener, dial func(context.Context) (net.Conn, error)) error {
	go func() {
		<-ctx.Done()
		_ = ln.Close()
	}()

	var (
		wg     sync.WaitGroup
		mu     sync.Mutex
		active = map[net.Conn]struct{}{}
		closed bool
		slots  = make(chan struct{}, MaxProxyConns)
	)
	track := func(c net.Conn) bool {
		mu.Lock()
		defer mu.Unlock()
		if closed {
			return false
		}
		active[c] = struct{}{}
		return true
	}
	untrack := func(c net.Conn) {
		mu.Lock()
		delete(active, c)
		mu.Unlock()
	}
	defer func() {
		mu.Lock()
		closed = true
		for c := range active {
			_ = c.Close()
		}
		mu.Unlock()
		wg.Wait()
	}()

	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return nil
			}
			// A transient accept failure; don't spin.
			time.Sleep(50 * time.Millisecond)
			continue
		}
		select {
		case slots <- struct{}{}:
		default:
			_ = conn.Close()
			continue
		}
		if !track(conn) {
			_ = conn.Close()
			return nil
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-slots }()
			defer conn.Close()
			defer untrack(conn)
			upstream, err := dial(ctx)
			if err != nil {
				return
			}
			defer upstream.Close()
			if !track(upstream) {
				return
			}
			defer untrack(upstream)
			errc := make(chan struct{}, 2)
			go func() {
				_, _ = io.Copy(upstream, conn)
				errc <- struct{}{}
			}()
			go func() {
				_, _ = io.Copy(conn, upstream)
				errc <- struct{}{}
			}()
			<-errc
		}()
	}
}
