package rfb

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"image/jpeg"
	"io"
	"math"
	"math/rand/v2"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// testScreen is a 256x128 frame with a flat area, a two-color area, a few
// colors, and a photo-like gradient, so every encoder path runs.
func testScreen(seed int) Frame {
	w, h := 256, 128
	pix := make([]byte, w*h*4)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var r, g, b byte
			switch {
			case x < 64: // flat
				r, g, b = 30, 60, byte(90+seed)
			case x < 128: // text-like: two colors
				if (x+y+seed)%7 < 2 {
					r, g, b = 255, 255, 255
				}
			case x < 192: // a few colors
				v := byte(((x/8 + y/8 + seed) % 5) * 50)
				r, g, b = v, 255-v, v/2
			default: // gradient: many colors
				r, g, b = byte(x*3+seed), byte(y*2), byte(x+y)
			}
			i := (y*w + x) * 4
			pix[i], pix[i+1], pix[i+2] = b, g, r
		}
	}
	return Frame{Width: w, Height: h, Pix: pix}
}

func sendEncodings(t *testing.T, conn net.Conn, encs ...int32) {
	t.Helper()
	msg := []byte{2, 0}
	msg = binary.BigEndian.AppendUint16(msg, uint16(len(encs)))
	for _, e := range encs {
		msg = binary.BigEndian.AppendUint32(msg, uint32(e))
	}
	if _, err := conn.Write(msg); err != nil {
		t.Fatal(err)
	}
}

// testClient decodes updates into an RGB framebuffer, as a viewer would.
type testClient struct {
	t      *testing.T
	conn   net.Conn
	w, h   int
	rgb    []byte // 3 bytes per pixel
	format PixelFormat
	tightZ [4]io.ReadCloser
	tightR [4]*bytes.Buffer
	zrleZ  io.ReadCloser
	zrleR  *bytes.Buffer
	jpegs  int
	bytes  int

	cursorRects int
	cursorPix   []byte
	cursorMask  []byte
}

func newTestClient(t *testing.T, conn net.Conn, w, h int) *testClient {
	return &testClient{t: t, conn: conn, w: w, h: h, rgb: make([]byte, w*h*3), format: DefaultPixelFormat()}
}

func (c *testClient) read(n int) []byte {
	c.t.Helper()
	buf := make([]byte, n)
	if _, err := io.ReadFull(c.conn, buf); err != nil {
		c.t.Fatal(err)
	}
	c.bytes += n
	return buf
}

func (c *testClient) u8() int  { return int(c.read(1)[0]) }
func (c *testClient) u16() int { return int(binary.BigEndian.Uint16(c.read(2))) }

// readMessage reads one server message and returns its type. Updates are
// applied to the framebuffer; fences return their payload.
func (c *testClient) readMessage() (int, []Rect, uint32) {
	c.t.Helper()
	kind := c.u8()
	switch kind {
	case 0:
		c.read(1)
		n := c.u16()
		var rects []Rect
		for i := 0; i < n; i++ {
			h := c.read(12)
			r := Rect{
				X: int(binary.BigEndian.Uint16(h[0:2])), Y: int(binary.BigEndian.Uint16(h[2:4])),
				W: int(binary.BigEndian.Uint16(h[4:6])), H: int(binary.BigEndian.Uint16(h[6:8])),
			}
			rects = append(rects, r)
			switch enc := int32(binary.BigEndian.Uint32(h[8:12])); enc {
			case encodingRaw:
				c.raw(r)
			case encodingTight:
				c.tightRect(r)
			case encodingZRLE:
				c.zrleRect(r)
			case encodingCursor:
				n := int(c.format.BitsPerPixel / 8)
				c.cursorPix = c.read(r.W * r.H * n)
				c.cursorMask = c.read((r.W + 7) / 8 * r.H)
				c.cursorRects++
			default:
				c.t.Fatalf("unexpected encoding %d", enc)
			}
		}
		return 0, rects, 0
	case 150:
		return 150, nil, 0
	case 248:
		head := c.read(8)
		payload := c.read(int(head[7]))
		if binary.BigEndian.Uint32(head[3:7])&(1<<31) == 0 || len(payload) != 4 {
			c.t.Fatalf("bad fence %v %v", head, payload)
		}
		return 248, nil, binary.BigEndian.Uint32(payload)
	default:
		c.t.Fatalf("unexpected message type %d", kind)
	}
	return 0, nil, 0
}

func (c *testClient) set(x, y int, r, g, b byte) {
	i := (y*c.w + x) * 3
	c.rgb[i], c.rgb[i+1], c.rgb[i+2] = r, g, b
}

// decodePixel turns a pixel in the client's format back into 8-bit color.
func (c *testClient) decodePixel(px uint32) (byte, byte, byte) {
	f := c.format
	ch := func(shift uint8, max uint16) byte {
		return byte((px >> shift & uint32(max)) * 255 / uint32(max))
	}
	return ch(f.RedShift, f.RedMax), ch(f.GreenShift, f.GreenMax), ch(f.BlueShift, f.BlueMax)
}

func (c *testClient) readPixel(n int) uint32 {
	b := c.read(n)
	return c.pixelFrom(b)
}

func (c *testClient) pixelFrom(b []byte) uint32 {
	var px uint32
	if c.format.BigEndian {
		for _, v := range b {
			px = px<<8 | uint32(v)
		}
	} else {
		for i := len(b) - 1; i >= 0; i-- {
			px = px<<8 | uint32(b[i])
		}
	}
	return px
}

func (c *testClient) raw(r Rect) {
	n := int(c.format.BitsPerPixel / 8)
	for y := r.Y; y < r.Y+r.H; y++ {
		for x := r.X; x < r.X+r.W; x++ {
			cr, cg, cb := c.decodePixel(c.readPixel(n))
			c.set(x, y, cr, cg, cb)
		}
	}
}

func (c *testClient) compactLength() int {
	b := c.u8()
	n := b & 0x7f
	if b&0x80 != 0 {
		b = c.u8()
		n |= (b & 0x7f) << 7
		if b&0x80 != 0 {
			n |= c.u8() << 14
		}
	}
	return n
}

// inflate feeds compressed bytes to a persistent zlib stream and reads n
// bytes out.
func inflate(t *testing.T, z *io.ReadCloser, src **bytes.Buffer, data []byte, n int) []byte {
	t.Helper()
	if *src == nil {
		*src = &bytes.Buffer{}
	}
	(*src).Write(data)
	if *z == nil {
		r, err := zlib.NewReader(*src)
		if err != nil {
			t.Fatal(err)
		}
		*z = r
	}
	out := make([]byte, n)
	if _, err := io.ReadFull(*z, out); err != nil {
		t.Fatalf("inflate: %v", err)
	}
	return out
}

func (c *testClient) tightRect(r Rect) {
	ctl := c.u8()
	if ctl&0x0f != 0 {
		// noVNC can't decode a stream after being told it restarted.
		c.t.Fatalf("tight control %#x restarts a zlib stream", ctl)
	}
	kind := ctl >> 4
	switch {
	case kind == 0x8:
		p := c.read(3)
		for y := r.Y; y < r.Y+r.H; y++ {
			for x := r.X; x < r.X+r.W; x++ {
				c.set(x, y, p[0], p[1], p[2])
			}
		}
	case kind == 0x9:
		data := c.read(c.compactLength())
		img, err := jpeg.Decode(bytes.NewReader(data))
		if err != nil {
			c.t.Fatal(err)
		}
		c.jpegs++
		for y := 0; y < r.H; y++ {
			for x := 0; x < r.W; x++ {
				cr, cg, cb, _ := img.At(x, y).RGBA()
				c.set(r.X+x, r.Y+y, byte(cr>>8), byte(cg>>8), byte(cb>>8))
			}
		}
	case kind&0x8 == 0:
		stream := kind & 0x3
		filter := 0
		if kind&0x4 != 0 {
			filter = c.u8()
		}
		var pal [][3]byte
		size := r.W * r.H * 3
		if filter == 1 {
			n := c.u8() + 1
			for i := 0; i < n; i++ {
				p := c.read(3)
				pal = append(pal, [3]byte{p[0], p[1], p[2]})
			}
			if n == 2 {
				size = (r.W + 7) / 8 * r.H
			} else {
				size = r.W * r.H
			}
		} else if filter != 0 {
			c.t.Fatalf("unexpected tight filter %d", filter)
		}
		var data []byte
		if size < 12 {
			data = c.read(size)
		} else {
			data = inflate(c.t, &c.tightZ[stream], &c.tightR[stream], c.read(c.compactLength()), size)
		}
		for y := 0; y < r.H; y++ {
			for x := 0; x < r.W; x++ {
				var p [3]byte
				switch {
				case filter == 0:
					i := (y*r.W + x) * 3
					p = [3]byte{data[i], data[i+1], data[i+2]}
				case len(pal) == 2:
					bit := data[y*((r.W+7)/8)+x/8] >> (7 - x%8) & 1
					p = pal[bit]
				default:
					p = pal[data[y*r.W+x]]
				}
				c.set(r.X+x, r.Y+y, p[0], p[1], p[2])
			}
		}
	default:
		c.t.Fatalf("unexpected tight control %#x", ctl)
	}
}

func (c *testClient) zrleRect(r Rect) {
	n := int(binary.BigEndian.Uint32(c.read(4)))
	compressed := c.read(n)
	if c.zrleR == nil {
		c.zrleR = &bytes.Buffer{}
	}
	c.zrleR.Write(compressed)
	if c.zrleZ == nil {
		z, err := zlib.NewReader(c.zrleR)
		if err != nil {
			c.t.Fatal(err)
		}
		c.zrleZ = z
	}
	cpixel := c.format.compactPixelSize()
	next := func(k int) []byte {
		buf := make([]byte, k)
		if _, err := io.ReadFull(c.zrleZ, buf); err != nil {
			c.t.Fatalf("zrle inflate: %v", err)
		}
		return buf
	}
	for ty := r.Y; ty < r.Y+r.H; ty += TileSize {
		th := min(TileSize, r.Y+r.H-ty)
		for tx := r.X; tx < r.X+r.W; tx += TileSize {
			tw := min(TileSize, r.X+r.W-tx)
			sub := int(next(1)[0])
			put := func(x, y int, px uint32) {
				cr, cg, cb := c.decodePixel(px)
				c.set(tx+x, ty+y, cr, cg, cb)
			}
			switch {
			case sub == 0:
				for y := 0; y < th; y++ {
					for x := 0; x < tw; x++ {
						put(x, y, c.pixelFrom(next(cpixel)))
					}
				}
			case sub == 1:
				px := c.pixelFrom(next(cpixel))
				for y := 0; y < th; y++ {
					for x := 0; x < tw; x++ {
						put(x, y, px)
					}
				}
			case sub <= 16:
				pal := make([]uint32, sub)
				for i := range pal {
					pal[i] = c.pixelFrom(next(cpixel))
				}
				bits := 4
				if sub <= 2 {
					bits = 1
				} else if sub <= 4 {
					bits = 2
				}
				rowBytes := (tw*bits + 7) / 8
				for y := 0; y < th; y++ {
					row := next(rowBytes)
					for x := 0; x < tw; x++ {
						bit := x * bits
						idx := row[bit/8] >> (8 - bits - bit%8) & (1<<bits - 1)
						put(x, y, pal[idx])
					}
				}
			default:
				c.t.Fatalf("unexpected zrle subencoding %d", sub)
			}
		}
	}
}

// diff returns the largest per-channel difference and the PSNR between
// the client's framebuffer and frame.
func (c *testClient) diff(frame Frame) (int, float64) {
	worst := 0
	var sq float64
	for y := 0; y < c.h; y++ {
		for x := 0; x < c.w; x++ {
			i, j := (y*c.w+x)*3, (y*frame.Width+x)*4
			for k, want := range []byte{frame.Pix[j+2], frame.Pix[j+1], frame.Pix[j]} {
				d := int(c.rgb[i+k]) - int(want)
				if d < 0 {
					d = -d
				}
				worst = max(worst, d)
				sq += float64(d * d)
			}
		}
	}
	mse := sq / float64(c.w*c.h*3)
	if mse == 0 {
		return worst, math.Inf(1)
	}
	return worst, 10 * math.Log10(255*255/mse)
}

func fullRequest(t *testing.T, conn net.Conn, w, h int) {
	requestUpdate(t, conn, false, w, h)
}

func TestTightLosslessRebuildsTheScreen(t *testing.T) {
	frame := testScreen(0)
	conn := startServer(t, func() (Frame, error) { return frame, nil })
	sendEncodings(t, conn, encodingTight, encodingRaw)
	c := newTestClient(t, conn, frame.Width, frame.Height)
	fullRequest(t, conn, frame.Width, frame.Height)
	c.readMessage()
	if worst, _ := c.diff(frame); worst != 0 {
		t.Fatalf("lossless tight differs by up to %d", worst)
	}
	if c.jpegs != 0 {
		t.Fatalf("lossless sent %d JPEGs", c.jpegs)
	}
}

func TestTightQualityControlsJPEG(t *testing.T) {
	frame := testScreen(0)
	sizes := map[int]int{}
	for _, q := range []int{1, 8} {
		conn := startServer(t, func() (Frame, error) { return frame, nil })
		sendEncodings(t, conn, encodingTight, encodingQualityLevel0+int32(q))
		c := newTestClient(t, conn, frame.Width, frame.Height)
		fullRequest(t, conn, frame.Width, frame.Height)
		c.readMessage()
		if c.jpegs == 0 {
			t.Fatalf("quality %d sent no JPEG", q)
		}
		_, psnr := c.diff(frame)
		if (q == 8 && psnr < 30) || psnr < 20 {
			t.Fatalf("quality %d PSNR %.1f dB", q, psnr)
		}
		// Flat and few-color areas stay exact at any quality.
		for y := 0; y < frame.Height; y++ {
			for x := 0; x < 192; x++ {
				i, j := (y*frame.Width+x)*3, (y*frame.Width+x)*4
				if c.rgb[i] != frame.Pix[j+2] || c.rgb[i+1] != frame.Pix[j+1] || c.rgb[i+2] != frame.Pix[j] {
					t.Fatalf("quality %d blurred the exact area at %d,%d", q, x, y)
				}
			}
		}
		sizes[q] = c.bytes
	}
	if sizes[1] >= sizes[8] {
		t.Fatalf("quality 1 = %d bytes, quality 8 = %d bytes; lower quality should be smaller", sizes[1], sizes[8])
	}
}

func TestTightKeepsStreamsAcrossUpdates(t *testing.T) {
	var mu sync.Mutex
	seed := 0
	conn := startServer(t, func() (Frame, error) {
		mu.Lock()
		defer mu.Unlock()
		return testScreen(seed), nil
	})
	sendEncodings(t, conn, encodingTight, encodingCompressLevel0+2)
	c := newTestClient(t, conn, 256, 128)
	for i := 0; i < 4; i++ {
		mu.Lock()
		seed = i
		mu.Unlock()
		requestUpdate(t, conn, i > 0, 256, 128)
		c.readMessage()
		if worst, _ := c.diff(testScreen(i)); worst != 0 {
			t.Fatalf("update %d differs by up to %d", i, worst)
		}
	}
}

func TestZRLERebuildsTheScreenInEveryFormat(t *testing.T) {
	formats := map[string]PixelFormat{
		"32-bit": DefaultPixelFormat(),
		"16-bit big-endian": {
			BitsPerPixel: 16, Depth: 16, BigEndian: true, TrueColor: true,
			RedMax: 31, GreenMax: 63, BlueMax: 31, RedShift: 11, GreenShift: 5,
		},
		"8-bit": {
			BitsPerPixel: 8, Depth: 8, TrueColor: true,
			RedMax: 7, GreenMax: 7, BlueMax: 3, GreenShift: 3, BlueShift: 6,
		},
	}
	for name, f := range formats {
		t.Run(name, func(t *testing.T) {
			frame := testScreen(1)
			conn := startServer(t, func() (Frame, error) { return frame, nil })
			setPixelFormat(t, conn, f)
			sendEncodings(t, conn, encodingZRLE, encodingRaw)
			c := newTestClient(t, conn, frame.Width, frame.Height)
			c.format = f
			// Compare against what the format can represent.
			want := Frame{Width: frame.Width, Height: frame.Height, Pix: make([]byte, len(frame.Pix))}
			for i := 0; i < len(frame.Pix); i += 4 {
				r, g, b := c.decodePixel(f.pixel(frame.Pix[i+2], frame.Pix[i+1], frame.Pix[i]))
				want.Pix[i], want.Pix[i+1], want.Pix[i+2] = b, g, r
			}
			fullRequest(t, conn, frame.Width, frame.Height)
			c.readMessage()
			if worst, _ := c.diff(want); worst != 0 {
				t.Fatalf("zrle differs by up to %d", worst)
			}
		})
	}
}

func TestContinuousUpdatesArePacedByFences(t *testing.T) {
	var n atomic.Int64
	conn := startServer(t, func() (Frame, error) {
		// A new image every capture.
		return testScreen(int(n.Add(1))), nil
	})
	sendEncodings(t, conn, encodingTight, encodingFence, encodingContinuous)
	c := newTestClient(t, conn, 256, 128)
	if kind, _, _ := c.readMessage(); kind != 150 {
		t.Fatalf("message %d, want EndOfContinuousUpdates", kind)
	}
	enable := []byte{150, 1, 0, 0, 0, 0, 1, 0, 0, 128}
	if _, err := conn.Write(enable); err != nil {
		t.Fatal(err)
	}

	// Without fence replies, at most fenceWindow updates arrive.
	var fences []uint32
	for len(fences) < fenceWindow {
		kind, _, seq := c.readMessage()
		if kind == 248 {
			fences = append(fences, seq)
		}
	}
	expectSilence(t, conn)

	// Answering a fence lets the next update through.
	reply := []byte{248, 0, 0, 0, 0, 0, 0, 0, 4}
	reply = binary.BigEndian.AppendUint32(reply, fences[len(fences)-1])
	if _, err := conn.Write(reply); err != nil {
		t.Fatal(err)
	}
	if kind, rects, _ := c.readMessage(); kind != 0 || len(rects) == 0 {
		t.Fatalf("after fence reply got message %d with %d rects", kind, len(rects))
	}
}

func TestInputIsNotHeldUpBySlowCapture(t *testing.T) {
	got := make(chan uint32, 1)
	server := &Server{
		Password: "secret",
		Capture: func() (Frame, error) {
			time.Sleep(400 * time.Millisecond)
			return redFrame(), nil
		},
		Key: func(keysym uint32, down bool) { got <- keysym },
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
	if _, _, _, err := readServerInit(conn); err != nil {
		t.Fatal(err)
	}

	requestUpdate(t, conn, false, 1, 1)
	time.Sleep(50 * time.Millisecond) // the capture is now running
	start := time.Now()
	if _, err := conn.Write([]byte{4, 1, 0, 0, 0, 0, 0, 0x41}); err != nil {
		t.Fatal(err)
	}
	select {
	case k := <-got:
		if k != 0x41 || time.Since(start) > 150*time.Millisecond {
			t.Fatalf("key %#x after %s", k, time.Since(start))
		}
	case <-time.After(time.Second):
		t.Fatal("key never arrived")
	}
}

func TestUnchangedSeqSkipsTheCompare(t *testing.T) {
	frame := testScreen(0)
	frame.Seq = 7
	var calls atomic.Int64
	conn := startServer(t, func() (Frame, error) {
		calls.Add(1)
		return frame, nil
	})
	fullRequest(t, conn, frame.Width, frame.Height)
	readUpdate(t, conn, 4)
	requestUpdate(t, conn, true, frame.Width, frame.Height)
	expectSilence(t, conn)
	if calls.Load() < 3 {
		t.Fatalf("captured %d times; the server should keep checking for changes", calls.Load())
	}
}

func TestCompactLength(t *testing.T) {
	for _, n := range []int{0, 1, 127, 128, 16383, 16384, 4194303} {
		b := appendCompactLength(nil, n)
		got, shift := 0, 0
		for i, v := range b {
			if i == 2 {
				got |= int(v) << 14
				break
			}
			got |= int(v&0x7f) << shift
			shift += 7
		}
		if got != n {
			t.Fatalf("compact length %d round-tripped to %d (%v)", n, got, b)
		}
	}
}

func TestRaisingQualityResendsBlurredTiles(t *testing.T) {
	frame := testScreen(0)
	frame.Seq = 1 // never changes
	conn := startServer(t, func() (Frame, error) { return frame, nil })
	sendEncodings(t, conn, encodingTight, encodingQualityLevel0+2)
	c := newTestClient(t, conn, frame.Width, frame.Height)
	fullRequest(t, conn, frame.Width, frame.Height)
	c.readMessage()
	if worst, _ := c.diff(frame); worst == 0 {
		t.Fatal("quality 2 should have blurred the gradient")
	}

	// The viewer raises quality when input stops; the same still picture
	// must come back exact without a full refresh request.
	sendEncodings(t, conn, encodingTight, encodingQualityLevel0+9)
	requestUpdate(t, conn, true, frame.Width, frame.Height)
	_, rects, _ := c.readMessage()
	if worst, _ := c.diff(frame); worst != 0 {
		t.Fatalf("after raising quality the screen differs by up to %d", worst)
	}
	// Only the blurred gradient (the right quarter) is resent.
	for _, r := range rects {
		if r.X < 192 {
			t.Fatalf("resent exact tile %+v", r)
		}
	}
	requestUpdate(t, conn, true, frame.Width, frame.Height)
	expectSilence(t, conn)
}

// arrowShape is a 4x4 pointer: opaque red, with a transparent corner.
func arrowShape(id uint64) *CursorShape {
	pix := make([]byte, 4*4*4)
	for i := 0; i < 16; i++ {
		pix[i*4+2], pix[i*4+3] = 255, 255 // red, opaque
	}
	pix[15*4+3] = 0
	return &CursorShape{Width: 4, Height: 4, HotX: 1, HotY: 1, Pix: pix, ID: id}
}

type pointerScreen struct {
	mu     sync.Mutex
	cursor Cursor
}

func (p *pointerScreen) capture() (Frame, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	f := testScreen(0)
	f.Seq = 1
	cur := p.cursor
	f.Cursor = &cur
	return f, nil
}

func (p *pointerScreen) set(fn func(c *Cursor)) {
	p.mu.Lock()
	fn(&p.cursor)
	p.mu.Unlock()
}

func TestViewerDrawnPointerCostsNoUpdates(t *testing.T) {
	screen := &pointerScreen{cursor: Cursor{Visible: true, X: 10, Y: 10, Shape: arrowShape(1)}}
	conn := startServer(t, screen.capture)
	sendEncodings(t, conn, encodingTight, encodingCursor)
	c := newTestClient(t, conn, 256, 128)
	fullRequest(t, conn, 256, 128)
	c.readMessage()
	if c.cursorRects != 1 || len(c.cursorMask) != 4 || c.cursorMask[3] != 0xE0 {
		t.Fatalf("cursor rects %d, mask %v", c.cursorRects, c.cursorMask)
	}
	// The picture leaves the pointer out.
	if worst, _ := c.diff(testScreen(0)); worst != 0 {
		t.Fatalf("picture differs by %d; the pointer should not be drawn in", worst)
	}

	// Moving the pointer sends nothing: the viewer draws it.
	screen.set(func(cur *Cursor) { cur.X, cur.Y = 100, 50 })
	requestUpdate(t, conn, true, 256, 128)
	expectSilence(t, conn)

	// A new shape is sent once, alone.
	screen.set(func(cur *Cursor) { cur.Shape = arrowShape(2) })
	_, rects, _ := c.readMessage()
	if len(rects) != 1 || c.cursorRects != 2 {
		t.Fatalf("shape change sent %d rects, %d cursors", len(rects), c.cursorRects)
	}
}

func TestPointerIsDrawnInForOtherViewers(t *testing.T) {
	screen := &pointerScreen{cursor: Cursor{Visible: true, X: 10, Y: 10, Shape: arrowShape(1)}}
	conn := startServer(t, screen.capture)
	sendEncodings(t, conn, encodingTight)
	c := newTestClient(t, conn, 256, 128)
	fullRequest(t, conn, 256, 128)
	c.readMessage()
	at := func(x, y int) [3]byte {
		i := (y*c.w + x) * 3
		return [3]byte{c.rgb[i], c.rgb[i+1], c.rgb[i+2]}
	}
	// Hotspot (1,1) at (10,10): the shape covers 9..12.
	if got := at(9, 9); got != [3]byte{255, 0, 0} {
		t.Fatalf("pointer pixel = %v, want red", got)
	}
	if c.cursorRects != 0 {
		t.Fatal("sent a shape to a viewer that did not ask for one")
	}

	screen.set(func(cur *Cursor) { cur.X, cur.Y = 200, 100 })
	requestUpdate(t, conn, true, 256, 128)
	_, rects, _ := c.readMessage()
	if got := at(199, 99); got != [3]byte{255, 0, 0} {
		t.Fatalf("moved pointer pixel = %v, want red", got)
	}
	if worst, _ := c.diff(func() Frame {
		f := testScreen(0)
		f.Pix = composite(nil, f.Pix, f.Width, f.Height, &Cursor{Visible: true, X: 200, Y: 100, Shape: arrowShape(1)})
		return f
	}()); worst != 0 {
		t.Fatalf("after the move the picture differs by %d", worst)
	}
	if len(rects) > 4 {
		t.Fatalf("a pointer move resent %d rects; want only the tiles it touched", len(rects))
	}
}

func TestTightSurvivesQualityAndCompressionChanges(t *testing.T) {
	var mu sync.Mutex
	seed := 0
	conn := startServer(t, func() (Frame, error) {
		mu.Lock()
		defer mu.Unlock()
		return testScreen(seed), nil
	})
	c := newTestClient(t, conn, 256, 128)
	// What the viewers send as quality moves: the quality level and a
	// compression level that goes with it.
	steps := [][2]int32{{6, 3}, {9, 0}, {6, 3}, {2, 7}, {9, 1}, {7, 0}, {9, 0}}
	for i, step := range steps {
		sendEncodings(t, conn, encodingTight, encodingQualityLevel0+step[0], encodingCompressLevel0+step[1])
		mu.Lock()
		seed = i + 1
		want := testScreen(seed)
		mu.Unlock()
		if i == 0 {
			fullRequest(t, conn, 256, 128)
		} else {
			requestUpdate(t, conn, true, 256, 128)
		}
		c.readMessage()
		if worst, _ := c.diff(want); step[0] == 9 && worst != 0 {
			t.Fatalf("step %d (quality %d, compression %d): screen differs by up to %d", i, step[0], step[1], worst)
		}
	}
}

func TestZstreamChangesLevelWithoutRestarting(t *testing.T) {
	// Three blocks of noise, sent round and round: a block costs its full
	// size the first time and next to nothing after, but only to a
	// compressor that still has the earlier ones.
	rng := rand.New(rand.NewPCG(1, 2))
	blocks := make([][]byte, 3)
	for i := range blocks {
		blocks[i] = make([]byte, 8000)
		for j := range blocks[i] {
			blocks[i][j] = byte(rng.Uint32())
		}
	}
	var z zstream
	var stream bytes.Buffer
	var want []byte
	levels := []int{3, 3, 3, 3, 6, 9, 2, 2, 1, 7, 7}
	sizes := make([]int, len(levels))
	for i, level := range levels {
		data := blocks[i%3]
		out := z.compress(nil, data, level)
		sizes[i] = len(out)
		stream.Write(out)
		want = append(want, data...)

		// One reader for the whole stream, as a viewer has: every chunk
		// must be readable as soon as it arrives.
		r, err := zlib.NewReader(bytes.NewReader(stream.Bytes()))
		if err != nil {
			t.Fatal(err)
		}
		got := make([]byte, len(want))
		if _, err := io.ReadFull(r, got); err != nil {
			t.Fatalf("after chunk %d (level %d): %v", i, level, err)
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("after chunk %d (level %d): stream decodes to different data", i, level)
		}
	}
	// Chunks 4 to 6 each come straight after a change of level and
	// repeat a block the stream carried before the change.
	for i := 4; i <= 6; i++ {
		if sizes[i] > len(blocks[0])/10 {
			t.Fatalf("chunk %d at level %d took %d bytes for a repeated block: history was lost (sizes %v)", i, levels[i], sizes[i], sizes)
		}
	}
}

func TestZstreamHistoryStaysBounded(t *testing.T) {
	var z zstream
	data := bytes.Repeat([]byte("0123456789abcdef"), 1000)
	for i := 0; i < 50; i++ {
		z.compress(nil, data, 1+i%9)
		if len(z.history) > 2*zWindow+len(data) {
			t.Fatalf("history grew to %d bytes", len(z.history))
		}
	}
}
