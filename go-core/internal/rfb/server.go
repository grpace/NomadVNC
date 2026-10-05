package rfb

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/binary"
	"errors"
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
	if err := s.handshake(reader, conn); err != nil {
		if errors.Is(err, ErrAuth) {
			s.log("VNC authentication failed")
		}
		return
	}
	s.log("VNC client connected")

	format := DefaultPixelFormat()
	var sent []byte
	sentW, sentH := 0, 0
	for {
		kind, err := reader.ReadByte()
		if err != nil {
			return
		}
		switch kind {
		case 0:
			format, err = readSetPixelFormat(reader)
		case 2:
			err = skipEncodings(reader)
		case 3:
			req, reqErr := readUpdateRequest(reader)
			if reqErr != nil {
				return
			}
			if err = s.sendUpdate(conn, req, format, &sent, &sentW, &sentH); err != nil {
				return
			}
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

func (s *Server) handshake(reader *bufio.Reader, conn net.Conn) error {
	if _, err := conn.Write([]byte(protocolVersion)); err != nil {
		return err
	}
	version, err := readFull(reader, 12)
	if err != nil {
		return err
	}
	if string(version) < "RFB 003.007\n" {
		return errors.New("unsupported VNC version")
	}

	if _, err := conn.Write([]byte{1, 2}); err != nil {
		return err
	}
	choice, err := reader.ReadByte()
	if err != nil {
		return err
	}
	if choice != 2 {
		return errors.New("client rejected VNC authentication")
	}

	var challenge [16]byte
	if _, err := rand.Read(challenge[:]); err != nil {
		return err
	}
	if _, err := conn.Write(challenge[:]); err != nil {
		return err
	}
	response, err := readFull(reader, 16)
	if err != nil {
		return err
	}
	expect := VNCAuthResponse(challenge, s.Password)
	if subtle.ConstantTimeCompare(response, expect[:]) != 1 {
		reason := "Authentication failed"
		buf := binary.BigEndian.AppendUint32(nil, 1)
		buf = binary.BigEndian.AppendUint32(buf, uint32(len(reason)))
		buf = append(buf, reason...)
		_, _ = conn.Write(buf)
		return ErrAuth
	}
	if _, err := conn.Write([]byte{0, 0, 0, 0}); err != nil {
		return err
	}

	if _, err := reader.ReadByte(); err != nil {
		return err
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
	return err
}

func (s *Server) sendUpdate(conn net.Conn, req updateRequest, format PixelFormat, sent *[]byte, sentW, sentH *int) error {
	frame, err := s.Capture()
	if err != nil || frame.Width <= 0 || frame.Height <= 0 || len(frame.Pix) < frame.Width*frame.Height*4 {
		_, err = conn.Write([]byte{0, 0, 0, 0})
		return err
	}
	if !format.supported() {
		format = DefaultPixelFormat()
	}

	var tiles []Rect
	full := !req.Incremental || *sentW != frame.Width || *sentH != frame.Height || len(*sent) < len(frame.Pix)
	if full {
		tiles = DirtyTiles(nil, frame.Pix, frame.Width, frame.Height)
	} else {
		tiles = DirtyTiles(*sent, frame.Pix, frame.Width, frame.Height)
	}
	tiles = clipTiles(tiles, req)

	buf := []byte{0, 0}
	buf = binary.BigEndian.AppendUint16(buf, uint16(len(tiles)))
	for _, tile := range tiles {
		buf = appendRawRect(buf, frame.Pix, frame.Width, tile, format)
	}
	if _, err := conn.Write(buf); err != nil {
		return err
	}
	copied := make([]byte, len(frame.Pix))
	copy(copied, frame.Pix)
	*sent = copied
	*sentW = frame.Width
	*sentH = frame.Height
	return nil
}

func clipTiles(tiles []Rect, req updateRequest) []Rect {
	if req.W <= 0 || req.H <= 0 {
		return tiles
	}
	out := tiles[:0]
	x1 := req.X + req.W
	y1 := req.Y + req.H
	for _, tile := range tiles {
		if tile.X+tile.W <= req.X || tile.Y+tile.H <= req.Y || tile.X >= x1 || tile.Y >= y1 {
			continue
		}
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

func skipEncodings(r io.Reader) error {
	buf, err := readFull(r, 3)
	if err != nil {
		return err
	}
	count := int(binary.BigEndian.Uint16(buf[1:3]))
	if count < 0 || count > 64 {
		return errors.New("invalid encoding count")
	}
	_, err = readFull(r, count*4)
	return err
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
