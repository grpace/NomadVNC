package rfb

import (
	"bufio"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"slices"
	"sync"
	"time"
)

const (
	// FrameInterval is how often a connection looks for screen changes
	// while the client is waiting for one: about 60 frames a second.
	FrameInterval = 16 * time.Millisecond
	// fenceWindow is how many continuous updates may be unacknowledged.
	// More would queue frames in network buffers and add lag on a slow
	// link; fewer would idle the link for a round trip per frame.
	fenceWindow = 2

	encodingDesktopSize = -223
)

// session is one client. A reader goroutine applies input as soon as it
// arrives and records what the client wants; the writer (the connection's
// own goroutine) captures, encodes, and sends, so a slow capture or a
// large update never delays keys or pointer moves.
type session struct {
	srv  *Server
	conn net.Conn
	wake chan struct{}

	mu           sync.Mutex
	format       PixelFormat
	encodings    []int32
	desktopSize  bool
	fences       bool
	cursorShape  bool // the client draws the pointer from its shape
	needColorMap bool
	needEndCU    bool
	announcedCU  bool
	req          *updateRequest // pending FramebufferUpdateRequest, merged
	cuOn         bool
	cuRect       Rect
	fenceAcked   uint32
	// ended is why the connection ended, the first reason seen.
	ended string

	// Writer only.
	width, height int // framebuffer size the client knows
	sent          []byte
	sentW, sentH  int
	sentKey       frameKey
	// view is the frame with the pointer drawn in, for clients that don't
	// draw it themselves; viewKey says which frame and pointer it holds.
	view         []byte
	viewKey      frameKey
	cursorID     uint64 // pointer shape last sent; 0 = hidden or none
	cursorSent   bool
	localCursor  bool // the client has been drawing the pointer
	debt         bool // changed tiles outside the last request are unsent
	fenceSent    uint32
	tight        tightEncoder
	zrle         zrleEncoder
	updates      int
	bytesOut     int64
	lastSettings encoderSettings
	// fidelity is, per tile, how exactly the client's copy was sent (see
	// encoderSettings.fidelity), so a quality increase can resend the
	// tiles it would improve.
	fidelity []int8
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

	// A client that stalls before signing in is dropped. The wait for a
	// wrong-password delay counts too, so it can't hold a slot forever.
	_ = conn.SetDeadline(time.Now().Add(HandshakeTimeout + maxAuthDelay))
	reader := bufio.NewReader(conn)
	width, height, err := s.handshake(reader, conn)
	_ = conn.SetDeadline(time.Time{})
	if err != nil {
		if errors.Is(err, ErrAuth) {
			s.log("VNC authentication failed")
		}
		return
	}
	s.log("VNC client connected")

	c := &session{
		srv:    s,
		conn:   conn,
		wake:   make(chan struct{}, 1),
		format: DefaultPixelFormat(),
		width:  width,
		height: height,
	}
	started := time.Now()
	readDone := make(chan struct{})
	go func() {
		defer close(readDone)
		c.readLoop(reader)
	}()
	c.writeLoop(readDone)
	_ = conn.Close()
	<-readDone
	if s.Disconnected != nil {
		s.Disconnected()
	}
	s.log(c.summary(time.Since(started)))
}

func (c *session) summary(d time.Duration) string {
	name := map[int32]string{encodingRaw: "raw", encodingTight: "tight", encodingZRLE: "zrle"}[c.lastSettings.encoding]
	quality := "lossless"
	if c.lastSettings.encoding == encodingTight && c.lastSettings.lossy() {
		quality = fmt.Sprintf("quality %d", c.lastSettings.quality)
	}
	c.mu.Lock()
	why := c.ended
	c.mu.Unlock()
	if why == "" {
		why = "the server stopped"
	}
	return fmt.Sprintf("VNC client disconnected after %s (%s): %d updates, %.1f MB, %s %s",
		d.Round(time.Second), why, c.updates, float64(c.bytesOut)/1e6, name, quality)
}

func (c *session) signal() {
	select {
	case c.wake <- struct{}{}:
	default:
	}
}

func (c *session) readLoop(reader *bufio.Reader) {
	for {
		kind, err := reader.ReadByte()
		if err != nil {
			c.end(readEnd(err))
			return
		}
		switch kind {
		case 0:
			var f PixelFormat
			if f, err = readSetPixelFormat(reader); err == nil {
				c.mu.Lock()
				c.format = f
				c.needColorMap = !f.TrueColor && f.supported()
				c.mu.Unlock()
				c.signal()
			}
		case 2:
			var encs []int32
			if encs, err = readEncodings(reader); err == nil {
				c.setEncodings(encs)
				c.signal()
			}
		case 3:
			var req updateRequest
			if req, err = readUpdateRequest(reader); err == nil {
				c.mu.Lock()
				c.req = mergeRequest(c.req, req)
				c.mu.Unlock()
				c.signal()
			}
		case 4:
			var down bool
			var keysym uint32
			if down, keysym, err = readKeyEvent(reader); err == nil && c.srv.Key != nil {
				c.srv.Key(keysym, down)
			}
		case 5:
			var buttons byte
			var x, y int
			if buttons, x, y, err = readPointerEvent(reader); err == nil && c.srv.Pointer != nil {
				c.srv.Pointer(x, y, buttons)
			}
		case 6:
			err = skipCutText(reader)
		case 150:
			err = c.readEnableContinuous(reader)
		case 248:
			err = c.readClientFence(reader)
		default:
			c.end(fmt.Sprintf("the viewer sent message type %d, which this server doesn't know", kind))
			return
		}
		if err != nil {
			c.end(fmt.Sprintf("message type %d cut short: %v", kind, err))
			return
		}
	}
}

// end records why the connection ended. Only the first reason is kept:
// what follows it is the other side of the same ending.
func (c *session) end(why string) {
	c.mu.Lock()
	if c.ended == "" {
		c.ended = why
	}
	c.mu.Unlock()
}

// readEnd describes a failed read of the next message.
func readEnd(err error) string {
	if errors.Is(err, io.EOF) {
		return "the viewer closed it"
	}
	return "lost: " + err.Error()
}

func (c *session) setEncodings(encs []int32) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.encodings = encs
	c.desktopSize, c.fences, c.cursorShape = false, false, false
	continuous := false
	for _, enc := range encs {
		switch enc {
		case encodingDesktopSize:
			c.desktopSize = true
		case encodingFence:
			c.fences = true
		case encodingCursor:
			c.cursorShape = true
		case encodingContinuous:
			continuous = true
		}
	}
	// Continuous updates are offered only with fences, which pace them.
	// EndOfContinuousUpdates is the announcement.
	if continuous && c.fences && !c.announcedCU {
		c.announcedCU = true
		c.needEndCU = true
	}
}

func (c *session) readEnableContinuous(r io.Reader) error {
	buf, err := readFull(r, 9)
	if err != nil {
		return err
	}
	c.mu.Lock()
	if buf[0] != 0 {
		c.cuOn = true
		c.cuRect = Rect{
			X: int(binary.BigEndian.Uint16(buf[1:3])),
			Y: int(binary.BigEndian.Uint16(buf[3:5])),
			W: int(binary.BigEndian.Uint16(buf[5:7])),
			H: int(binary.BigEndian.Uint16(buf[7:9])),
		}
	} else if c.cuOn {
		c.cuOn = false
		c.needEndCU = true
	}
	c.mu.Unlock()
	c.signal()
	return nil
}

func (c *session) readClientFence(r io.Reader) error {
	head, err := readFull(r, 8)
	if err != nil {
		return err
	}
	payload, err := readFull(r, int(head[7]))
	if err != nil {
		return err
	}
	if len(payload) == 4 {
		c.mu.Lock()
		c.fenceAcked = binary.BigEndian.Uint32(payload)
		c.mu.Unlock()
		c.signal()
	}
	return nil
}

// mergeRequest folds a new FramebufferUpdateRequest into a pending one: the
// union of their areas, plus the union of the areas to resend whole.
func mergeRequest(pending *updateRequest, req updateRequest) *updateRequest {
	if pending == nil {
		return &req
	}
	merged := union(pending.rect(), req.rect())
	return &updateRequest{
		Incremental: pending.Incremental && req.Incremental,
		X:           merged.X, Y: merged.Y, W: merged.W, H: merged.H,
		full: union(pending.full, req.full),
	}
}

func union(a, b Rect) Rect {
	if a.W <= 0 || a.H <= 0 {
		return b
	}
	if b.W <= 0 || b.H <= 0 {
		return a
	}
	x0, y0 := min(a.X, b.X), min(a.Y, b.Y)
	x1, y1 := max(a.X+a.W, b.X+b.W), max(a.Y+a.H, b.Y+b.H)
	return Rect{X: x0, Y: y0, W: x1 - x0, H: y1 - y0}
}

func intersects(t, r Rect) bool {
	return t.X < r.X+r.W && r.X < t.X+t.W && t.Y < r.Y+r.H && r.Y < t.Y+t.H
}

// writeLoop sends updates until the reader stops or a write fails.
func (c *session) writeLoop(readDone <-chan struct{}) {
	ticker := time.NewTicker(FrameInterval)
	defer ticker.Stop()
	for {
		select {
		case <-readDone:
			return
		case <-c.wake:
		case <-ticker.C:
		}
		if err := c.step(); err != nil {
			c.end("sending failed: " + err.Error())
			return
		}
	}
}

// step sends whatever is due: control messages, then at most one update.
func (c *session) step() error {
	c.mu.Lock()
	format, encs, desktopSize, fences, cursorShape := c.format, c.encodings, c.desktopSize, c.fences, c.cursorShape
	needColorMap, needEndCU := c.needColorMap, c.needEndCU
	c.needColorMap, c.needEndCU = false, false
	req := c.req
	c.req = nil
	cuOn, cuRect := c.cuOn, c.cuRect
	inflight := c.fenceSent - c.fenceAcked
	c.mu.Unlock()

	if needColorMap {
		if err := c.write(colorMapEntries()); err != nil {
			return err
		}
	}
	if needEndCU {
		if err := c.write([]byte{150}); err != nil {
			return err
		}
	}
	continuous := cuOn && inflight < fenceWindow
	if req == nil && !continuous {
		return nil
	}

	sent, err := c.update(req, continuous, cuRect, format, encs, desktopSize, cursorShape)
	if err != nil {
		return err
	}
	if !sent {
		// Nothing changed: hold the request until something does.
		if req != nil {
			c.mu.Lock()
			if c.req == nil {
				c.req = req
			} else {
				merged := mergeRequest(req, *c.req)
				c.req = merged
			}
			c.mu.Unlock()
		}
		return nil
	}
	if cuOn && fences {
		c.fenceSent++
		msg := []byte{248, 0, 0, 0, 0x80, 0, 0, 0, 4}
		msg = binary.BigEndian.AppendUint32(msg, c.fenceSent)
		return c.write(msg)
	}
	return nil
}

func (c *session) write(b []byte) error {
	_, err := c.conn.Write(b)
	c.bytesOut += int64(len(b))
	return err
}

// update captures the screen and sends one FramebufferUpdate. It returns
// false, sending nothing, when an incremental request or continuous update
// has no changes to carry.
func (c *session) update(req *updateRequest, continuous bool, cuRect Rect, format PixelFormat, encs []int32, desktopSize, cursorShape bool) (bool, error) {
	frame, err := c.srv.Capture()
	if err != nil || frame.Width <= 0 || frame.Height <= 0 || len(frame.Pix) < frame.Width*frame.Height*4 {
		if req != nil && !req.Incremental {
			return true, c.write([]byte{0, 0, 0, 0})
		}
		return false, nil
	}
	if !format.supported() {
		format = DefaultPixelFormat()
	}

	if (frame.Width != c.width || frame.Height != c.height) && desktopSize {
		// Tell the client the new size. Its next request (or continuous
		// updates) gets the whole screen because sent no longer matches.
		buf := []byte{0, 0, 0, 1}
		buf = appendRectHeader(buf, Rect{W: frame.Width, H: frame.Height}, encodingDesktopSize)
		c.width, c.height = frame.Width, frame.Height
		c.sent = nil
		return true, c.write(buf)
	}

	// The pointer: drawn by the client from its shape, or into the picture.
	local := cursorShape && frame.Cursor != nil
	if local != c.localCursor {
		// The picture switches between with and without the pointer.
		c.localCursor = local
		c.sent = nil
		c.cursorSent = false
	}
	key := frameKey{seq: frame.Seq}
	pix := frame.Pix
	if frame.Cursor != nil && !local {
		key.cursor = keyOf(frame.Cursor)
		if frame.Seq == 0 || key != c.viewKey || len(c.view) != len(frame.Pix) {
			c.view = composite(c.view, frame.Pix, frame.Width, frame.Height, frame.Cursor)
			c.viewKey = key
		}
		pix = c.view
	}
	var cursorRect []byte
	if local {
		id := keyOf(frame.Cursor).id
		if !c.cursorSent || id != c.cursorID {
			cursorRect = appendCursorRect(nil, frame.Cursor, format)
			c.cursorID, c.cursorSent = id, true
		}
	}

	valid := c.sentW == frame.Width && c.sentH == frame.Height && len(c.sent) == frame.Width*frame.Height*4
	settings := parseEncodings(encs, format)
	if valid && settings.fidelity() > c.lastSettings.fidelity() {
		c.refreshBelow(settings.fidelity(), frame.Width, frame.Height)
	}
	c.lastSettings = settings
	var dirty []Rect
	switch {
	case !valid:
		dirty = DirtyTiles(nil, pix, frame.Width, frame.Height)
	case frame.Seq != 0 && key == c.sentKey && !c.debt:
		// Same image as last time: nothing to compare.
	default:
		dirty = DirtyTiles(c.sent, pix, frame.Width, frame.Height)
	}

	// Changed tiles go out if they are in an area the client asked for;
	// a non-incremental request also resends its area unchanged.
	var area Rect
	if continuous {
		area = cuRect
	}
	var forced Rect
	if req != nil {
		area = union(area, req.rect())
		forced = req.full
	}
	var tiles, skipped []Rect
	seen := map[[2]int]bool{}
	for _, t := range dirty {
		if area.W > 0 && area.H > 0 && !intersects(t, area) {
			skipped = append(skipped, t)
			continue
		}
		seen[[2]int{t.X, t.Y}] = true
		tiles = append(tiles, t)
	}
	if forced.W > 0 && forced.H > 0 {
		for _, t := range gridTiles(frame.Width, frame.Height) {
			if intersects(t, forced) && !seen[[2]int{t.X, t.Y}] {
				tiles = append(tiles, t)
			}
		}
	}
	if len(tiles) == 0 && cursorRect == nil && (req == nil || req.Incremental) {
		return false, nil
	}

	// Remember what the client now has, before cropping: pixels beyond a
	// framebuffer that can't resize are never shown, so they count as sent.
	if valid {
		for _, t := range tiles {
			copyTile(c.sent, pix, frame.Width, t)
		}
	} else {
		c.sent = append(c.sent[:0], pix[:frame.Width*frame.Height*4]...)
		for _, t := range skipped {
			invertTile(c.sent, frame.Width, t)
		}
	}
	c.sentW, c.sentH, c.sentKey = frame.Width, frame.Height, key
	c.debt = len(skipped) > 0
	tiles = cropTiles(tiles, c.width, c.height)
	sortTiles(tiles)

	buf := []byte{0, 0}
	buf = binary.BigEndian.AppendUint16(buf, 0) // rect count, set below
	count := len(tiles)
	switch settings.encoding {
	case encodingTight:
		var lossy []Rect
		buf, count, lossy = c.tight.encode(buf, pix, frame.Width, tiles, settings)
		c.recordFidelity(frame.Width, frame.Height, tiles, exactFidelity)
		c.recordFidelity(frame.Width, frame.Height, lossy, settings.fidelity())
	case encodingZRLE:
		spans := mergeSpans(tiles)
		count = len(spans)
		buf = c.zrle.encode(buf, pix, frame.Width, spans, format, settings.zlibLevel())
	default:
		for _, t := range tiles {
			buf = appendRawRect(buf, pix, frame.Width, t, format)
		}
	}
	if cursorRect != nil {
		buf = append(buf, cursorRect...)
		count++
	}
	if settings.encoding != encodingTight {
		c.recordFidelity(frame.Width, frame.Height, tiles, exactFidelity)
	}
	binary.BigEndian.PutUint16(buf[2:4], uint16(count))
	c.updates++
	return true, c.write(buf)
}

// frameKey identifies the picture a client was sent: the capture and,
// when the server draws the pointer in, the pointer.
type frameKey struct {
	seq    uint64
	cursor cursorKey
}

// sortTiles orders tiles by row, then column, so neighbors are adjacent.
func sortTiles(tiles []Rect) {
	slices.SortFunc(tiles, func(a, b Rect) int {
		if a.Y != b.Y {
			return a.Y - b.Y
		}
		return a.X - b.X
	})
}

// mergeSpans joins sorted tiles that touch along a row into wider
// rectangles, up to spanMaxTiles each.
func mergeSpans(tiles []Rect) []Rect {
	var out []Rect
	n := 0
	for _, t := range tiles {
		if len(out) > 0 {
			last := &out[len(out)-1]
			if n < spanMaxTiles && t.Y == last.Y && t.H == last.H && t.X == last.X+last.W {
				last.W += t.W
				n++
				continue
			}
		}
		out = append(out, t)
		n = 1
	}
	return out
}

func gridTiles(width, height int) []Rect {
	var out []Rect
	for y := 0; y < height; y += TileSize {
		for x := 0; x < width; x += TileSize {
			out = append(out, Rect{X: x, Y: y, W: min(TileSize, width-x), H: min(TileSize, height-y)})
		}
	}
	return out
}

func copyTile(dst, src []byte, width int, t Rect) {
	for row := t.Y; row < t.Y+t.H; row++ {
		start := (row*width + t.X) * 4
		copy(dst[start:start+t.W*4], src[start:start+t.W*4])
	}
}

// invertTile makes a tile differ from the frame so it counts as changed.
func invertTile(buf []byte, width int, t Rect) {
	for row := t.Y; row < t.Y+t.H; row++ {
		start := (row*width + t.X) * 4
		for i := start; i < start+t.W*4; i++ {
			buf[i] = ^buf[i]
		}
	}
}

// tileIndex is a tile's position in the per-tile fidelity grid.
func tileIndex(width, x, y int) int {
	cols := (width + TileSize - 1) / TileSize
	return (y/TileSize)*cols + x/TileSize
}

// recordFidelity notes how exactly the tiles under rects were sent.
func (c *session) recordFidelity(width, height int, rects []Rect, f int8) {
	cols, rows := (width+TileSize-1)/TileSize, (height+TileSize-1)/TileSize
	if len(c.fidelity) != cols*rows {
		c.fidelity = make([]int8, cols*rows)
		for i := range c.fidelity {
			c.fidelity[i] = exactFidelity
		}
	}
	for _, r := range rects {
		for y := r.Y; y < r.Y+r.H; y += TileSize {
			for x := r.X; x < r.X+r.W; x += TileSize {
				c.fidelity[tileIndex(width, x, y)] = f
			}
		}
	}
}

// refreshBelow marks tiles sent at less than f as changed, so they go out
// again at the new quality. The viewers raise quality when input stops,
// expecting the still picture to sharpen.
func (c *session) refreshBelow(f int8, width, height int) {
	if len(c.fidelity) == 0 {
		return
	}
	for _, t := range gridTiles(width, height) {
		i := tileIndex(width, t.X, t.Y)
		if i < len(c.fidelity) && c.fidelity[i] < f {
			invertTile(c.sent, width, t)
			c.debt = true
		}
	}
}
