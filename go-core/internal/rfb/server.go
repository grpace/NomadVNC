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
)

const protocolVersion = "RFB 003.008\n"

// ErrAuth is returned when a client sends the wrong VNC password.
// The server does not retry that connection.
var ErrAuth = errors.New("authentication failed")

// Frame is one captured screen. Pix is top-down BGRA, tightly packed.
// The caller owns Pix and may reuse it after Capture returns.
type Frame struct {
	Width  int
	Height int
	Pix    []byte
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
	Log     func(string)
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

func (s *Server) serveConn(ctx context.Context, conn net.Conn) {
	defer conn.Close()
	done := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = conn.Close()
		case <-done:
		}
	}()
	defer close(done)

	reader := bufio.NewReader(conn)
	width, height, err := s.handshake(reader, conn)
	if err != nil {
		if errors.Is(err, ErrAuth) {
			s.log("VNC authentication failed")
		}
		return
	}
	s.log("VNC client connected")

	c := &clientState{format: DefaultPixelFormat(), width: width, height: height}
	for {
		kind, err := reader.ReadByte()
		if err != nil {
			return
		}
		switch kind {
		case 0:
			c.format, err = readSetPixelFormat(reader)
			if err == nil && !c.format.TrueColor && c.format.supported() {
				_, err = conn.Write(colorMapEntries())
			}
		case 2:
			var encodings []int32
			encodings, err = readEncodings(reader)
			c.desktopSize = false
			for _, enc := range encodings {
				if enc == encodingDesktopSize {
					c.desktopSize = true
				}
			}
		case 3:
			req, reqErr := readUpdateRequest(reader)
			if reqErr != nil {
				return
			}
			err = s.sendUpdate(conn, req, c)
		case 4:
			down, keysym, keyErr := readKeyEvent(reader)
			if keyErr != nil {
				return
			}
			if s.Key != nil {
				s.Key(keysym, down)
			}
		case 5:
			buttons, x, y, ptrErr := readPointerEvent(reader)
			if ptrErr != nil {
				return
			}
			if s.Pointer != nil {
				s.Pointer(x, y, buttons)
			}
		case 6:
			err = skipCutText(reader)
		default:
			return
		}
		if err != nil {
			return
		}
	}
}

// encodingDesktopSize is the pseudo-encoding a client lists when it can
// follow a change of screen size.
const encodingDesktopSize = -223

// clientState is what one connection has negotiated and been sent.
type clientState struct {
	format PixelFormat
	// width and height are the framebuffer size the client knows about.
	width, height int
	desktopSize   bool
	// sent is the last frame sent, sentW x sentH, for incremental diffs.
	sent         []byte
	sentW, sentH int
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
	expect := VNCAuthResponse(challenge, s.Password)
	if subtle.ConstantTimeCompare(response, expect[:]) != 1 {
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

func (s *Server) sendUpdate(conn net.Conn, req updateRequest, c *clientState) error {
	frame, err := s.Capture()
	if err != nil || frame.Width <= 0 || frame.Height <= 0 || len(frame.Pix) < frame.Width*frame.Height*4 {
		_, err = conn.Write([]byte{0, 0, 0, 0})
		return err
	}
	format := c.format
	if !format.supported() {
		format = DefaultPixelFormat()
	}

	if (frame.Width != c.width || frame.Height != c.height) && c.desktopSize {
		// Tell the client the new size. It answers with a fresh request,
		// which gets the whole screen because sent no longer matches.
		buf := []byte{0, 0, 0, 1, 0, 0, 0, 0}
		buf = binary.BigEndian.AppendUint16(buf, uint16(frame.Width))
		buf = binary.BigEndian.AppendUint16(buf, uint16(frame.Height))
		enc := int32(encodingDesktopSize)
		buf = binary.BigEndian.AppendUint32(buf, uint32(enc))
		if _, err := conn.Write(buf); err != nil {
			return err
		}
		c.width, c.height = frame.Width, frame.Height
		c.sent = nil
		return nil
	}

	var tiles []Rect
	full := !req.Incremental || c.sentW != frame.Width || c.sentH != frame.Height || len(c.sent) < len(frame.Pix)
	if full {
		tiles = DirtyTiles(nil, frame.Pix, frame.Width, frame.Height)
	} else {
		tiles = DirtyTiles(c.sent, frame.Pix, frame.Width, frame.Height)
	}
	tiles, skipped := clipTiles(tiles, req)
	// A client that can't follow a resize keeps its old framebuffer;
	// never send pixels outside it.
	tiles = cropTiles(tiles, c.width, c.height)

	buf := []byte{0, 0}
	buf = binary.BigEndian.AppendUint16(buf, uint16(len(tiles)))
	for _, tile := range tiles {
		buf = appendRawRect(buf, frame.Pix, frame.Width, tile, format)
	}
	if _, err := conn.Write(buf); err != nil {
		return err
	}
	prev := c.sent
	c.sent = append([]byte(nil), frame.Pix[:frame.Width*frame.Height*4]...)
	// Changed tiles outside the requested area were not sent. Keep them
	// different from the frame so a later request picks them up.
	for _, tile := range skipped {
		markUnsent(c.sent, prev, full, frame.Width, tile)
	}
	c.sentW = frame.Width
	c.sentH = frame.Height
	return nil
}

// clipTiles splits tiles into those touching the requested area and
// those outside it.
func clipTiles(tiles []Rect, req updateRequest) (in, out []Rect) {
	if req.W <= 0 || req.H <= 0 {
		return tiles, nil
	}
	x1 := req.X + req.W
	y1 := req.Y + req.H
	for _, tile := range tiles {
		if tile.X+tile.W <= req.X || tile.Y+tile.H <= req.Y || tile.X >= x1 || tile.Y >= y1 {
			out = append(out, tile)
			continue
		}
		in = append(in, tile)
	}
	return in, out
}

// markUnsent puts back what the client still shows in tile: the previous
// frame's pixels, or inverted pixels when there is no usable previous
// frame, so the tile still differs from the frame and counts as changed.
func markUnsent(sent, prev []byte, full bool, width int, tile Rect) {
	for row := tile.Y; row < tile.Y+tile.H; row++ {
		start := (row*width + tile.X) * 4
		end := start + tile.W*4
		if !full {
			copy(sent[start:end], prev[start:end])
			continue
		}
		for i := start; i < end; i++ {
			sent[i] = ^sent[i]
		}
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
	return updateRequest{
		Incremental: buf[0] != 0,
		X:           int(binary.BigEndian.Uint16(buf[1:3])),
		Y:           int(binary.BigEndian.Uint16(buf[3:5])),
		W:           int(binary.BigEndian.Uint16(buf[5:7])),
		H:           int(binary.BigEndian.Uint16(buf[7:9])),
	}, nil
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
