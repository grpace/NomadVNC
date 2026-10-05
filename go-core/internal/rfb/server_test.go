package rfb

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"testing"
	"time"
)

func TestServerAuthFrameAndInput(t *testing.T) {
	frame := Frame{
		Width:  2,
		Height: 2,
		Pix: []byte{
			0, 0, 255, 0, // red
			0, 0, 0, 0,
			0, 0, 0, 0,
			0, 0, 0, 0,
		},
	}
	var gotKey uint32
	var gotDown bool
	var gotX, gotY int
	var gotButtons byte
	server := &Server{
		Password: "secret",
		Capture:  func() (Frame, error) { return frame, nil },
		Key: func(keysym uint32, down bool) {
			gotKey = keysym
			gotDown = down
		},
		Pointer: func(x, y int, buttons byte) {
			gotX, gotY, gotButtons = x, y, buttons
		},
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go server.Serve(t.Context(), ln)

	conn, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))

	if err := clientHandshake(conn, "secret"); err != nil {
		t.Fatal(err)
	}
	width, height, _, err := readServerInit(conn)
	if err != nil {
		t.Fatal(err)
	}
	if width != 2 || height != 2 {
		t.Fatalf("size = %dx%d", width, height)
	}

	if _, err := conn.Write([]byte{
		3, 0,
		0, 0, 0, 0, 0, 2, 0, 2,
	}); err != nil {
		t.Fatal(err)
	}
	header := make([]byte, 4)
	if _, err := io.ReadFull(conn, header); err != nil {
		t.Fatal(err)
	}
	if header[0] != 0 {
		t.Fatalf("update type = %d", header[0])
	}
	nrects := binary.BigEndian.Uint16(header[2:4])
	if nrects != 1 {
		t.Fatalf("rects = %d", nrects)
	}
	rect := make([]byte, 12)
	if _, err := io.ReadFull(conn, rect); err != nil {
		t.Fatal(err)
	}
	pix := make([]byte, 2*2*4)
	if _, err := io.ReadFull(conn, pix); err != nil {
		t.Fatal(err)
	}
	if pix[0] != 255 || pix[1] != 0 || pix[2] != 0 {
		t.Fatalf("first pixel = %v, want red", pix[:4])
	}

	// Key 'A' down, then a left click at (1, 1).
	key := []byte{4, 1, 0, 0, 0, 0, 0, 0x41}
	if _, err := conn.Write(key); err != nil {
		t.Fatal(err)
	}
	ptr := []byte{5, 1, 0, 1, 0, 1}
	if _, err := conn.Write(ptr); err != nil {
		t.Fatal(err)
	}
	time.Sleep(50 * time.Millisecond)
	if !gotDown || gotKey != 0x41 {
		t.Fatalf("key = down:%v sym:%#x", gotDown, gotKey)
	}
	if gotX != 1 || gotY != 1 || gotButtons != 1 {
		t.Fatalf("pointer = %d,%d buttons %d", gotX, gotY, gotButtons)
	}
}

func TestServerRejectsWrongPassword(t *testing.T) {
	server := &Server{
		Password: "secret",
		Capture: func() (Frame, error) {
			return Frame{Width: 1, Height: 1, Pix: []byte{0, 0, 0, 0}}, nil
		},
	}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go server.Serve(t.Context(), ln)

	conn, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	err = clientHandshake(conn, "nope")
	if !errors.Is(err, ErrAuth) {
		t.Fatalf("handshake err = %v, want auth failure", err)
	}
}

func clientHandshake(conn net.Conn, password string) error {
	version := make([]byte, 12)
	if _, err := io.ReadFull(conn, version); err != nil {
		return err
	}
	if _, err := conn.Write([]byte(protocolVersion)); err != nil {
		return err
	}
	sec := make([]byte, 2)
	if _, err := io.ReadFull(conn, sec); err != nil {
		return err
	}
	if _, err := conn.Write([]byte{2}); err != nil {
		return err
	}
	var challenge [16]byte
	if _, err := io.ReadFull(conn, challenge[:]); err != nil {
		return err
	}
	response := VNCAuthResponse(challenge, password)
	if _, err := conn.Write(response[:]); err != nil {
		return err
	}
	result := make([]byte, 4)
	if _, err := io.ReadFull(conn, result); err != nil {
		return err
	}
	if binary.BigEndian.Uint32(result) != 0 {
		return ErrAuth
	}
	_, err := conn.Write([]byte{1})
	return err
}

func readServerInit(conn net.Conn) (int, int, string, error) {
	hdr := make([]byte, 2+2+16+4)
	if _, err := io.ReadFull(conn, hdr); err != nil {
		return 0, 0, "", err
	}
	width := int(binary.BigEndian.Uint16(hdr[0:2]))
	height := int(binary.BigEndian.Uint16(hdr[2:4]))
	nameLen := int(binary.BigEndian.Uint32(hdr[20:24]))
	name, err := readFull(conn, nameLen)
	if err != nil {
		return 0, 0, "", err
	}
	return width, height, string(name), nil
}

// TestManualFrame dials a running NomadVNC Host when NOMADVNC_VNC_ADDR is set.
// It checks that a real framebuffer comes back and, if NOMADVNC_VNC_OUT is
// set, writes that frame as a PPM image.
func TestManualFrame(t *testing.T) {
	addr := os.Getenv("NOMADVNC_VNC_ADDR")
	if addr == "" {
		t.Skip("set NOMADVNC_VNC_ADDR to check a live host")
	}
	password := os.Getenv("NOMADVNC_VNC_PASSWORD")
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(20 * time.Second))
	if err := clientHandshake(conn, password); err != nil {
		t.Fatal(err)
	}
	width, height, name, err := readServerInit(conn)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("desktop %q %dx%d", name, width, height)
	if width < 640 || height < 480 {
		t.Fatalf("framebuffer %dx%d", width, height)
	}
	if _, err := conn.Write([]byte{3, 0, 0, 0, 0, 0, byte(width >> 8), byte(width), byte(height >> 8), byte(height)}); err != nil {
		t.Fatal(err)
	}
	header := make([]byte, 4)
	if _, err := io.ReadFull(conn, header); err != nil {
		t.Fatal(err)
	}
	nrects := int(binary.BigEndian.Uint16(header[2:4]))
	if nrects < 1 {
		t.Fatal("no framebuffer rectangles")
	}
	var pix []byte
	for i := 0; i < nrects; i++ {
		rect := make([]byte, 12)
		if _, err := io.ReadFull(conn, rect); err != nil {
			t.Fatal(err)
		}
		w := int(binary.BigEndian.Uint16(rect[4:6]))
		h := int(binary.BigEndian.Uint16(rect[6:8]))
		raw := make([]byte, w*h*4)
		if _, err := io.ReadFull(conn, raw); err != nil {
			t.Fatal(err)
		}
		if i == 0 && w == width && h == height && len(pix) == 0 {
			pix = raw
			continue
		}
		if pix == nil {
			pix = make([]byte, width*height*4)
		}
		x := int(binary.BigEndian.Uint16(rect[0:2]))
		y := int(binary.BigEndian.Uint16(rect[2:4]))
		for row := 0; row < h; row++ {
			dst := ((y+row)*width + x) * 4
			src := row * w * 4
			copy(pix[dst:dst+w*4], raw[src:src+w*4])
		}
	}
	if len(pix) != width*height*4 {
		t.Fatalf("frame bytes %d", len(pix))
	}
	varied := false
	first := pix[0]
	for i := 0; i < len(pix); i += 64 {
		if pix[i] != first {
			varied = true
			break
		}
	}
	if !varied {
		t.Fatal("framebuffer is a single color")
	}
	out := os.Getenv("NOMADVNC_VNC_OUT")
	if out == "" {
		return
	}
	f, err := os.Create(out)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := fmt.Fprintf(f, "P6\n%d %d\n255\n", width, height); err != nil {
		t.Fatal(err)
	}
	rgb := make([]byte, width*height*3)
	for i := 0; i < width*height; i++ {
		rgb[i*3] = pix[i*4]
		rgb[i*3+1] = pix[i*4+1]
		rgb[i*3+2] = pix[i*4+2]
	}
	if _, err := f.Write(rgb); err != nil {
		t.Fatal(err)
	}
}

func TestManualClick(t *testing.T) {
	if os.Getenv("NOMADVNC_VNC_CLICK") == "" {
		t.Skip("set NOMADVNC_VNC_CLICK to send a click to a live host")
	}
	addr := os.Getenv("NOMADVNC_VNC_ADDR")
	password := os.Getenv("NOMADVNC_VNC_PASSWORD")
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(20 * time.Second))
	if err := clientHandshake(conn, password); err != nil {
		t.Fatal(err)
	}
	width, height, _, err := readServerInit(conn)
	if err != nil {
		t.Fatal(err)
	}
	x := width / 2
	y := height / 2
	// PointerEvent: buttons, x, y. Press then release at the center.
	press := []byte{5, 1, byte(x >> 8), byte(x), byte(y >> 8), byte(y)}
	release := []byte{5, 0, byte(x >> 8), byte(x), byte(y >> 8), byte(y)}
	if _, err := conn.Write(press); err != nil {
		t.Fatal(err)
	}
	if _, err := conn.Write(release); err != nil {
		t.Fatal(err)
	}
	time.Sleep(700 * time.Millisecond)
	if _, err := conn.Write([]byte{3, 0, 0, 0, 0, 0, byte(width >> 8), byte(width), byte(height >> 8), byte(height)}); err != nil {
		t.Fatal(err)
	}
	header := make([]byte, 4)
	if _, err := io.ReadFull(conn, header); err != nil {
		t.Fatal(err)
	}
	nrects := int(binary.BigEndian.Uint16(header[2:4]))
	pix := make([]byte, width*height*4)
	got := 0
	for i := 0; i < nrects; i++ {
		rect := make([]byte, 12)
		if _, err := io.ReadFull(conn, rect); err != nil {
			t.Fatal(err)
		}
		w := int(binary.BigEndian.Uint16(rect[4:6]))
		h := int(binary.BigEndian.Uint16(rect[6:8]))
		raw := make([]byte, w*h*4)
		if _, err := io.ReadFull(conn, raw); err != nil {
			t.Fatal(err)
		}
		rx := int(binary.BigEndian.Uint16(rect[0:2]))
		ry := int(binary.BigEndian.Uint16(rect[2:4]))
		for row := 0; row < h; row++ {
			dst := ((ry+row)*width + rx) * 4
			src := row * w * 4
			copy(pix[dst:dst+w*4], raw[src:src+w*4])
		}
		got++
	}
	if got == 0 {
		t.Fatal("click did not produce a framebuffer update")
	}
	out := os.Getenv("NOMADVNC_VNC_OUT")
	f, err := os.Create(out)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	if _, err := fmt.Fprintf(f, "P6\n%d %d\n255\n", width, height); err != nil {
		t.Fatal(err)
	}
	rgb := make([]byte, width*height*3)
	for i := 0; i < width*height; i++ {
		rgb[i*3] = pix[i*4]
		rgb[i*3+1] = pix[i*4+1]
		rgb[i*3+2] = pix[i*4+2]
	}
	if _, err := f.Write(rgb); err != nil {
		t.Fatal(err)
	}
	_ = pix
}
