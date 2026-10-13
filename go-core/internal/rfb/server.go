package rfb

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"time"
)

const protocolVersion = "RFB 003.008\n"

// ErrAuth is returned when a client sends the wrong VNC password.
// The server does not retry that connection.
var ErrAuth = errors.New("authentication failed")

// Frame is one captured screen. Pix is top-down BGRA, tightly packed, and
// must not change after Capture returns it: connections read it while
// encoding, possibly while another capture is running.
type Frame struct {
	Width  int
	Height int
	Pix    []byte
	// Seq numbers distinct images. A capture that returns the same Seq
	// (non-zero) as before promises identical pixels, so connections skip
	// comparing them. Zero means unknown.
	Seq uint64
	// Cursor, when set, is the pointer, which Pix then leaves out.
	Cursor *Cursor
}

// Server accepts VNC clients and sends raw framebuffer updates.
type Server struct {
	Password string
	// Name is the desktop name in the ServerInit handshake.
	Name string
	// Capture returns the current screen. It may be called for every
	// framebuffer request.
	Capture func() (Frame, error)
	Pointer func(x, y int, buttons byte)
	Key     func(keysym uint32, down bool)
	// Disconnected is called after a signed-in viewer's connection ends,
	// however it ended.
	Disconnected func()
	Log          func(string)

	limiter authLimiter
}

// Serve accepts connections until ctx is cancelled or ln is closed.
func (s *Server) Serve(ctx context.Context, ln net.Listener) error {
	if s.Capture == nil {
		return errors.New("vnc server has no screen capture")
	}
	go func() {
		<-ctx.Done()
		_ = ln.Close()
	}()

	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			continue
		}
		if tcp, ok := conn.(*net.TCPConn); ok {
			_ = tcp.SetNoDelay(true)
		}
		go s.serveConn(ctx, conn)
	}
}

func (s *Server) log(msg string) {
	if s.Log != nil {
		s.Log(msg)
	}
}

// handshake runs version, security and init, and returns the framebuffer
// size sent to the client. Clients speaking 3.3 through 3.8 are accepted;
// later versions are answered as 3.8.
func (s *Server) handshake(reader *bufio.Reader, conn net.Conn) (int, int, error) {
	if _, err := conn.Write([]byte(protocolVersion)); err != nil {
		return 0, 0, err
	}
	version, err := readFull(reader, 12)
	if err != nil {
		return 0, 0, err
	}
	minor, ok := parseVersion(version)
	if !ok {
		return 0, 0, errors.New("unsupported VNC version")
	}

	if minor == 3 {
		// 3.3: the server picks the security type.
		if _, err := conn.Write([]byte{0, 0, 0, 2}); err != nil {
			return 0, 0, err
		}
	} else {
		if _, err := conn.Write([]byte{1, 2}); err != nil {
			return 0, 0, err
		}
		choice, err := reader.ReadByte()
		if err != nil {
			return 0, 0, err
		}
		if choice != 2 {
			return 0, 0, errors.New("client rejected VNC authentication")
		}
	}

	var challenge [16]byte
	if _, err := rand.Read(challenge[:]); err != nil {
		return 0, 0, err
	}
	if _, err := conn.Write(challenge[:]); err != nil {
		return 0, 0, err
	}
	response, err := readFull(reader, 16)
	if err != nil {
		return 0, 0, err
	}
	// After repeated wrong passwords, attempts take turns and wait.
	host := s.limiter.host(hostOf(conn.RemoteAddr()))
	if wait := s.limiter.delay(host); wait > 0 {
		host.turn.Lock()
		time.Sleep(s.limiter.delay(host))
		host.turn.Unlock()
	}
	expect := VNCAuthResponse(challenge, s.Password)
	match := subtle.ConstantTimeCompare(response, expect[:]) == 1
	s.limiter.result(host, match)
	if !match {
		buf := binary.BigEndian.AppendUint32(nil, 1)
		if minor >= 8 {
			// Only 3.8 sends a reason after a failed SecurityResult.
			reason := "Authentication failed"
			buf = binary.BigEndian.AppendUint32(buf, uint32(len(reason)))
			buf = append(buf, reason...)
		}
		_, _ = conn.Write(buf)
		return 0, 0, ErrAuth
	}
	if _, err := conn.Write([]byte{0, 0, 0, 0}); err != nil {
		return 0, 0, err
	}

	if _, err := reader.ReadByte(); err != nil {
		return 0, 0, err
	}

	frame, err := s.Capture()
	if err != nil || frame.Width <= 0 || frame.Height <= 0 || len(frame.Pix) < frame.Width*frame.Height*4 {
		frame = Frame{Width: 1, Height: 1, Pix: []byte{0, 0, 0, 0}}
	}
	name := s.Name
	if name == "" {
		name = "NomadVNC Host"
	}
	init := binary.BigEndian.AppendUint16(nil, uint16(frame.Width))
	init = binary.BigEndian.AppendUint16(init, uint16(frame.Height))
	init = DefaultPixelFormat().appendWire(init)
	init = binary.BigEndian.AppendUint32(init, uint32(len(name)))
	init = append(init, name...)
	_, err = conn.Write(init)
	return frame.Width, frame.Height, err
}

// parseVersion reads a "RFB xxx.yyy\n" ProtocolVersion and returns the
// minor version the server will speak: 3, 7 or 8. Unknown minors below 7
// (such as 3.5) fall back to 3.3, and anything newer to 3.8, as RFC 6143
// asks.
func parseVersion(version []byte) (int, bool) {
	var major, minor int
	if _, err := fmt.Sscanf(string(version), "RFB %03d.%03d\n", &major, &minor); err != nil || major < 3 {
		return 0, false
	}
	switch {
	case major > 3 || minor >= 8:
		return 8, true
	case minor == 7:
		return 7, true
	default:
		return 3, true
	}
}

// cropTiles trims tiles to a width x height framebuffer, dropping any
// that fall outside it.
func cropTiles(tiles []Rect, width, height int) []Rect {
	out := tiles[:0]
	for _, tile := range tiles {
		if tile.X >= width || tile.Y >= height {
			continue
		}
		tile.W = min(tile.W, width-tile.X)
		tile.H = min(tile.H, height-tile.Y)
		out = append(out, tile)
	}
	return out
}

type updateRequest struct {
	Incremental bool
	X, Y, W, H  int
	// full is the area to resend whole: non-incremental requests'.
	full Rect
}

func (r updateRequest) rect() Rect {
	return Rect{X: r.X, Y: r.Y, W: r.W, H: r.H}
}

func readSetPixelFormat(r io.Reader) (PixelFormat, error) {
	// 3 bytes of padding, then 16 bytes of pixel format.
	buf, err := readFull(r, 19)
	if err != nil {
		return PixelFormat{}, err
	}
	return pixelFormatFromWire(buf[3:19]), nil
}

func readEncodings(r io.Reader) ([]int32, error) {
	buf, err := readFull(r, 3)
	if err != nil {
		return nil, err
	}
	count := int(binary.BigEndian.Uint16(buf[1:3]))
	list, err := readFull(r, count*4)
	if err != nil {
		return nil, err
	}
	encodings := make([]int32, count)
	for i := range encodings {
		encodings[i] = int32(binary.BigEndian.Uint32(list[i*4:]))
	}
	return encodings, nil
}

func readUpdateRequest(r io.Reader) (updateRequest, error) {
	buf, err := readFull(r, 9)
	if err != nil {
		return updateRequest{}, err
	}
	req := updateRequest{
		Incremental: buf[0] != 0,
		X:           int(binary.BigEndian.Uint16(buf[1:3])),
		Y:           int(binary.BigEndian.Uint16(buf[3:5])),
		W:           int(binary.BigEndian.Uint16(buf[5:7])),
		H:           int(binary.BigEndian.Uint16(buf[7:9])),
	}
	if !req.Incremental {
		req.full = req.rect()
	}
	return req, nil
}

func readKeyEvent(r io.Reader) (bool, uint32, error) {
	buf, err := readFull(r, 7)
	if err != nil {
		return false, 0, err
	}
	return buf[0] != 0, binary.BigEndian.Uint32(buf[3:7]), nil
}

func readPointerEvent(r io.Reader) (byte, int, int, error) {
	buf, err := readFull(r, 5)
	if err != nil {
		return 0, 0, 0, err
	}
	return buf[0], int(binary.BigEndian.Uint16(buf[1:3])), int(binary.BigEndian.Uint16(buf[3:5])), nil
}

func skipCutText(r *bufio.Reader) error {
	buf, err := readFull(r, 7)
	if err != nil {
		return err
	}
	n := int32(binary.BigEndian.Uint32(buf[3:7]))
	if n < 0 {
		n = -n
	}
	if n > 8<<20 {
		return errors.New("clipboard message too large")
	}
	_, err = readFull(r, int(n))
	return err
}

func readFull(r io.Reader, n int) ([]byte, error) {
	buf := make([]byte, n)
	_, err := io.ReadFull(r, buf)
	return buf, err
}
