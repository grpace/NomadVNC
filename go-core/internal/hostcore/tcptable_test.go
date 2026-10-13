package hostcore

import (
	"encoding/binary"
	"testing"
)

func tcpRow(localPort, remotePort uint16, pid uint32) []byte {
	r := make([]byte, 24)
	binary.LittleEndian.PutUint32(r[0:], 5) // ESTABLISHED
	copy(r[4:8], []byte{127, 0, 0, 1})
	binary.BigEndian.PutUint16(r[8:], localPort)
	copy(r[12:16], []byte{127, 0, 0, 1})
	binary.BigEndian.PutUint16(r[16:], remotePort)
	binary.LittleEndian.PutUint32(r[20:], pid)
	return r
}

func TestTCPOwnerFindsTheServerEnd(t *testing.T) {
	table := binary.LittleEndian.AppendUint32(nil, 3)
	// The client end of the same connection, owned by the service.
	table = append(table, tcpRow(50123, 5910, 100)...)
	table = append(table, tcpRow(5910, 50999, 300)...)
	table = append(table, tcpRow(5910, 50123, 200)...)
	pid, err := TCPOwner(table, 5910, 50123)
	if err != nil || pid != 200 {
		t.Fatalf("owner = %d, %v; want 200", pid, err)
	}
	if _, err := TCPOwner(table, 5910, 1); err == nil {
		t.Fatal("found a connection that is not there")
	}
	if _, err := TCPOwner(table[:10], 5910, 50123); err == nil {
		t.Fatal("read past a truncated table")
	}
}
