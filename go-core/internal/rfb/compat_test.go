package rfb

import (
	"bytes"
	"encoding/binary"
	"io"
	"net"
	"sync"
	"testing"
	"time"
)

// startServer serves capture on a loopback port and returns a connected,
// authenticated client that has read ServerInit.
func startServer(t *testing.T, capture func() (Frame, error)) net.Conn {
	t.Helper()
	server := &Server{Password: "secret", Capture: capture}
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go server.Serve(t.Context(), ln)

	conn, err := net.Dial("tcp", ln.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	if err := clientHandshake(conn, "secret"); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := readServerInit(conn); err != nil {
		t.Fatal(err)
	}
	return conn
}

func redFrame() Frame {
	return Frame{Width: 1, Height: 1, Pix: []byte{0, 0, 255, 0}}
}

func setPixelFormat(t *testing.T, conn net.Conn, f PixelFormat) {
	t.Helper()
	msg := f.appendWire([]byte{0, 0, 0, 0})
	if _, err := conn.Write(msg); err != nil {
		t.Fatal(err)
	}
}

func requestUpdate(t *testing.T, conn net.Conn, incremental bool, w, h int) {
	t.Helper()
	var inc byte
	if incremental {
		inc = 1
	}
	msg := []byte{3, inc, 0, 0, 0, 0, byte(w >> 8), byte(w), byte(h >> 8), byte(h)}
	if _, err := conn.Write(msg); err != nil {
		t.Fatal(err)
	}
}

type rectHeader struct {
	X, Y, W, H int
	Encoding   int32
}

// readUpdate reads a FramebufferUpdate header and its rectangle headers,
// reading bytesPerPixel*W*H bytes of raw data after each.
func readUpdate(t *testing.T, conn net.Conn, bytesPerPixel int) ([]rectHeader, [][]byte) {
	t.Helper()
	header := make([]byte, 4)
	if _, err := io.ReadFull(conn, header); err != nil {
		t.Fatal(err)
	}
	if header[0] != 0 {
		t.Fatalf("message type = %d, want FramebufferUpdate", header[0])
	}
	n := int(binary.BigEndian.Uint16(header[2:4]))
	var rects []rectHeader
	var data [][]byte
	for i := 0; i < n; i++ {
		buf := make([]byte, 12)
		if _, err := io.ReadFull(conn, buf); err != nil {
			t.Fatal(err)
		}
		r := rectHeader{
			X:        int(binary.BigEndian.Uint16(buf[0:2])),
			Y:        int(binary.BigEndian.Uint16(buf[2:4])),
			W:        int(binary.BigEndian.Uint16(buf[4:6])),
			H:        int(binary.BigEndian.Uint16(buf[6:8])),
			Encoding: int32(binary.BigEndian.Uint32(buf[8:12])),
		}
		rects = append(rects, r)
		var pix []byte
		if r.Encoding == 0 {
			pix = make([]byte, r.W*r.H*bytesPerPixel)
			if _, err := io.ReadFull(conn, pix); err != nil {
				t.Fatal(err)
			}
		}
		data = append(data, pix)
	}
	return rects, data
}

func TestServer16BitTrueColor(t *testing.T) {
	conn := startServer(t, func() (Frame, error) { return redFrame(), nil })
	// RGB565, big-endian.
	setPixelFormat(t, conn, PixelFormat{
		BitsPerPixel: 16, Depth: 16, BigEndian: true, TrueColor: true,
		RedMax: 31, GreenMax: 63, BlueMax: 31,
		RedShift: 11, GreenShift: 5, BlueShift: 0,
	})
	requestUpdate(t, conn, false, 1, 1)
	_, data := readUpdate(t, conn, 2)
	if got := binary.BigEndian.Uint16(data[0]); got != 0xF800 {
		t.Fatalf("red pixel = %#04x, want 0xf800", got)
	}
}

func TestServer8BitTrueColor(t *testing.T) {
	conn := startServer(t, func() (Frame, error) { return redFrame(), nil })
	// BGR233, as TightVNC and RealVNC use for low quality.
	setPixelFormat(t, conn, PixelFormat{
		BitsPerPixel: 8, Depth: 8, TrueColor: true,
		RedMax: 7, GreenMax: 7, BlueMax: 3,
		RedShift: 0, GreenShift: 3, BlueShift: 6,
	})
	requestUpdate(t, conn, false, 1, 1)
	_, data := readUpdate(t, conn, 1)
	if data[0][0] != 0x07 {
		t.Fatalf("red pixel = %#02x, want 0x07", data[0][0])
	}
}

func TestServerColorMap(t *testing.T) {
	conn := startServer(t, func() (Frame, error) { return redFrame(), nil })
	setPixelFormat(t, conn, PixelFormat{BitsPerPixel: 8, Depth: 8})

	msg := make([]byte, 6+256*6)
	if _, err := io.ReadFull(conn, msg); err != nil {
		t.Fatal(err)
	}
	if msg[0] != 1 || binary.BigEndian.Uint16(msg[4:6]) != 256 {
		t.Fatalf("SetColorMapEntries header = %v", msg[:6])
	}

	requestUpdate(t, conn, false, 1, 1)
	_, data := readUpdate(t, conn, 1)
	entry := msg[6+int(data[0][0])*6:]
	r := binary.BigEndian.Uint16(entry[0:2])
	g := binary.BigEndian.Uint16(entry[2:4])
	b := binary.BigEndian.Uint16(entry[4:6])
	if r != 65535 || g != 0 || b != 0 {
		t.Fatalf("palette color for red = %d,%d,%d", r, g, b)
	}
}

func TestServerManyEncodings(t *testing.T) {
	conn := startServer(t, func() (Frame, error) { return redFrame(), nil })
	msg := []byte{2, 0, 0, 200}
	for i := 0; i < 200; i++ {
		msg = binary.BigEndian.AppendUint32(msg, uint32(i))
	}
	if _, err := conn.Write(msg); err != nil {
		t.Fatal(err)
	}
	requestUpdate(t, conn, false, 1, 1)
	if rects, _ := readUpdate(t, conn, 4); len(rects) != 1 {
		t.Fatalf("rects = %d", len(rects))
	}
}

// resizingCapture returns a 2x2 frame until grow is called, then 4x3.
type resizingCapture struct {
	mu  sync.Mutex
	big bool
}

func (c *resizingCapture) capture() (Frame, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	w, h := 2, 2
	if c.big {
		w, h = 4, 3
	}
	return Frame{Width: w, Height: h, Pix: make([]byte, w*h*4)}, nil
}

func (c *resizingCapture) grow() {
	c.mu.Lock()
	c.big = true
	c.mu.Unlock()
}

func TestServerDesktopSize(t *testing.T) {
	cap := &resizingCapture{}
	conn := startServer(t, cap.capture)
	enc := int32(encodingDesktopSize)
	msg := binary.BigEndian.AppendUint32([]byte{2, 0, 0, 2}, 0)
	msg = binary.BigEndian.AppendUint32(msg, uint32(enc))
	if _, err := conn.Write(msg); err != nil {
		t.Fatal(err)
	}
	requestUpdate(t, conn, false, 2, 2)
	readUpdate(t, conn, 4)

	cap.grow()
	requestUpdate(t, conn, true, 2, 2)
	rects, _ := readUpdate(t, conn, 4)
	if len(rects) != 1 || rects[0].Encoding != encodingDesktopSize || rects[0].W != 4 || rects[0].H != 3 {
		t.Fatalf("resize update = %+v", rects)
	}

	requestUpdate(t, conn, true, 4, 3)
	rects, _ = readUpdate(t, conn, 4)
	if len(rects) != 1 || rects[0].W != 4 || rects[0].H != 3 {
		t.Fatalf("after resize = %+v, want the whole 4x3 screen", rects)
	}
}

func TestServerCropsWithoutDesktopSize(t *testing.T) {
	cap := &resizingCapture{}
	conn := startServer(t, cap.capture)
	requestUpdate(t, conn, false, 2, 2)
	readUpdate(t, conn, 4)

	cap.grow()
	requestUpdate(t, conn, false, 2, 2)
	rects, _ := readUpdate(t, conn, 4)
	for _, r := range rects {
		if r.X+r.W > 2 || r.Y+r.H > 2 {
			t.Fatalf("rect %+v is outside the 2x2 framebuffer", r)
		}
	}
	if len(rects) != 1 {
		t.Fatalf("rects = %+v", rects)
	}
}

func TestServerProtocolVersions(t *testing.T) {
	for _, tc := range []struct {
		client     string
		wrong      bool
		wantResult []byte
	}{
		{client: "RFB 003.003\n"},
		{client: "RFB 003.005\n"},
		{client: "RFB 003.007\n"},
		{client: "RFB 003.889\n"},
		{client: "RFB 003.007\n", wrong: true, wantResult: []byte{0, 0, 0, 1}},
		{client: "RFB 003.003\n", wrong: true, wantResult: []byte{0, 0, 0, 1}},
	} {
		t.Run(tc.client[:11], func(t *testing.T) {
			server := &Server{Password: "secret", Capture: func() (Frame, error) { return redFrame(), nil }}
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

			if _, err := readFull(conn, 12); err != nil {
				t.Fatal(err)
			}
			if _, err := conn.Write([]byte(tc.client)); err != nil {
				t.Fatal(err)
			}
			minor, _ := parseVersion([]byte(tc.client))
			if minor == 3 {
				sec, err := readFull(conn, 4)
				if err != nil || binary.BigEndian.Uint32(sec) != 2 {
					t.Fatalf("3.3 security = %v, %v", sec, err)
				}
			} else {
				if _, err := readFull(conn, 2); err != nil {
					t.Fatal(err)
				}
				if _, err := conn.Write([]byte{2}); err != nil {
					t.Fatal(err)
				}
			}
			var challenge [16]byte
			if _, err := io.ReadFull(conn, challenge[:]); err != nil {
				t.Fatal(err)
			}
			password := "secret"
			if tc.wrong {
				password = "nope"
			}
			response := VNCAuthResponse(challenge, password)
			if _, err := conn.Write(response[:]); err != nil {
				t.Fatal(err)
			}
			if tc.wrong {
				// No reason string before 3.8: the server closes right after.
				rest, _ := io.ReadAll(conn)
				if !bytes.Equal(rest, tc.wantResult) {
					t.Fatalf("failure reply = %v, want %v", rest, tc.wantResult)
				}
				return
			}
			result, err := readFull(conn, 4)
			if err != nil || binary.BigEndian.Uint32(result) != 0 {
				t.Fatalf("security result = %v, %v", result, err)
			}
			if _, err := conn.Write([]byte{1}); err != nil {
				t.Fatal(err)
			}
			if w, h, _, err := readServerInit(conn); err != nil || w != 1 || h != 1 {
				t.Fatalf("ServerInit = %dx%d, %v", w, h, err)
			}
		})
	}
}

func TestServerSendsTilesOutsideEarlierRequest(t *testing.T) {
	w, h := TileSize*2, TileSize
	conn := startServer(t, func() (Frame, error) {
		return Frame{Width: w, Height: h, Pix: make([]byte, w*h*4)}, nil
	})
	// Ask for the left tile only, then incrementally for everything: the
	// right tile was never sent, so it must come now.
	requestUpdate(t, conn, false, TileSize, TileSize)
	if rects, _ := readUpdate(t, conn, 4); len(rects) != 1 || rects[0].X != 0 {
		t.Fatalf("first update = %+v", rects)
	}
	requestUpdate(t, conn, true, w, h)
	rects, _ := readUpdate(t, conn, 4)
	if len(rects) != 1 || rects[0].X != TileSize {
		t.Fatalf("second update = %+v, want the right tile", rects)
	}
	// Nothing changed since, so an incremental request waits for a change
	// instead of getting an empty reply.
	requestUpdate(t, conn, true, w, h)
	expectSilence(t, conn)
}

// expectSilence checks that the server sends nothing for a while.
func expectSilence(t *testing.T, conn net.Conn) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(150 * time.Millisecond))
	var b [1]byte
	if n, err := conn.Read(b[:]); n > 0 || err == nil {
		t.Fatalf("got message type %d, want no reply", b[0])
	}
	_ = conn.SetReadDeadline(time.Now().Add(5 * time.Second))
}
