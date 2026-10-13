package hostcore

import (
	"encoding/binary"
	"errors"
	"fmt"
)

// TCPOwner finds, in a Windows MIB_TCPTABLE_OWNER_PID, the process owning
// the IPv4 connection with the given local and remote ports. The table is
// a count, then 24-byte rows of state, local address, local port, remote
// address, remote port, and owning process, each a uint32 with ports in
// network byte order.
func TCPOwner(table []byte, localPort, remotePort int) (uint32, error) {
	if len(table) < 4 {
		return 0, errors.New("short TCP table")
	}
	n := int(binary.LittleEndian.Uint32(table))
	const row = 24
	for i := 0; i < n; i++ {
		off := 4 + i*row
		if off+row > len(table) {
			break
		}
		r := table[off : off+row]
		lp := int(binary.BigEndian.Uint16(r[8:10]))
		rp := int(binary.BigEndian.Uint16(r[16:18]))
		if lp == localPort && rp == remotePort {
			return binary.LittleEndian.Uint32(r[20:24]), nil
		}
	}
	return 0, fmt.Errorf("no connection from port %d to %d", remotePort, localPort)
}
