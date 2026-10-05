package hostcore

import (
	"context"
	"errors"
	"io"
	"net"
	"sync"
)

// Proxy accepts connections on ln and copies bytes to a connection from dial.
// It returns when ctx is cancelled or ln is closed.
func Proxy(ctx context.Context, ln net.Listener, dial func(context.Context) (net.Conn, error)) error {
	go func() {
		<-ctx.Done()
		_ = ln.Close()
	}()

	var wg sync.WaitGroup
	defer wg.Wait()

	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, net.ErrClosed) {
				return nil
			}
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer conn.Close()
			upstream, err := dial(ctx)
			if err != nil {
				return
			}
			defer upstream.Close()
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
