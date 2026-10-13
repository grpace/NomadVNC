package main

import (
	"errors"
	"fmt"
	"net"
	"sync/atomic"
	"unsafe"

	"github.com/nomadvnc/nomadvnc/go-core/internal/hostcore"
	"golang.org/x/sys/windows"
)

// helperPID is the screen session the service started, 0 when none.
var helperPID atomic.Uint32

var procGetExtendedTcpTable = windows.NewLazySystemDLL("iphlpapi.dll").NewProc("GetExtendedTcpTable")

const tcpTableOwnerPIDAll = 5

// verifyHelperConn checks that the far end of conn, a connection to the
// helper's loopback port, belongs to the session process the service
// started. Any local user can listen on a loopback port; without this, a
// program that took the port first would receive remote viewers, and with
// them everything they type.
func verifyHelperConn(conn net.Conn) error {
	want := helperPID.Load()
	if want == 0 {
		return errors.New("no screen session is running")
	}
	local, ok := conn.LocalAddr().(*net.TCPAddr)
	remote, ok2 := conn.RemoteAddr().(*net.TCPAddr)
	if !ok || !ok2 {
		return errors.New("helper connection is not TCP")
	}
	owner, err := tcpOwner(remote.Port, local.Port)
	if err != nil {
		return err
	}
	if owner != want {
		return fmt.Errorf("port %d belongs to process %d, not the screen session %d", remote.Port, owner, want)
	}
	return nil
}

// tcpOwner returns the process owning the IPv4 connection whose local port
// is localPort and remote port is remotePort.
func tcpOwner(localPort, remotePort int) (uint32, error) {
	var size uint32
	for attempt := 0; attempt < 4; attempt++ {
		buf := make([]byte, max(size, 4096))
		size = uint32(len(buf))
		r, _, _ := procGetExtendedTcpTable.Call(
			uintptr(unsafe.Pointer(&buf[0])),
			uintptr(unsafe.Pointer(&size)),
			0,
			windows.AF_INET,
			tcpTableOwnerPIDAll,
			0,
		)
		if r == uintptr(windows.ERROR_INSUFFICIENT_BUFFER) {
			continue
		}
		if r != 0 {
			return 0, fmt.Errorf("GetExtendedTcpTable: %w", windows.Errno(r))
		}
		return hostcore.TCPOwner(buf, localPort, remotePort)
	}
	return 0, errors.New("TCP table kept growing")
}
