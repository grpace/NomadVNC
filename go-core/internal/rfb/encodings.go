package rfb

import (
	"bytes"
	"compress/flate"
	"encoding/binary"
	"image"
	"image/jpeg"
	"runtime"
	"sync"
	"sync/atomic"
)

const (
	encodingRaw   = 0
	encodingTight = 7
	encodingZRLE  = 16

	// Pseudo-encodings a client lists to pass settings.
	encodingQualityLevel0  = -32  // ..-23: JPEG quality 0-9
	encodingCompressLevel0 = -256 // ..-247: zlib effort 0-9
	encodingFence          = -312
	encodingContinuous     = -313

	// paletteMax is the most colors a tile can have and still be sent as a
	// palette: crisp and small for text, icons, and flat UI.
	paletteMax = 16
	// spanMaxTiles caps a merged JPEG strip at 16 tiles (1024 px), which
	// keeps every Tight rectangle within the 2048 px width and 65536 px
	// area that Tight viewers allow.
	spanMaxTiles = 16
)

// jpegQuality maps the client's 0-9 quality level to a JPEG quality.
// Level 9 is lossless, so it has no entry here. Same scale as TigerVNC.
var jpegQuality = [9]int{15, 29, 41, 42, 62, 77, 79, 86, 92}

// encoderSettings is what the client asked for in SetEncodings.
type encoderSettings struct {
	encoding int32
	// quality is 0-9, or -1 when the client sent none (lossless).
	quality int
	// compress is 0-9, or -1 when the client sent none.
	compress int
}

func (e encoderSettings) zlibLevel() int {
	switch {
	case e.compress < 0:
		return 6
	case e.compress == 0:
		// Level 0 stores without compressing. Level 1 costs little more
		// CPU and is several times smaller, so it is the floor.
		return 1
	default:
		return e.compress
	}
}

func (e encoderSettings) lossy() bool {
	return e.encoding == encodingTight && e.quality >= 0 && e.quality < 9
}

// fidelity ranks how exactly tiles are sent: the JPEG quality level, or
// exactFidelity when nothing is lost.
func (e encoderSettings) fidelity() int8 {
	if e.lossy() {
		return int8(e.quality)
	}
	return exactFidelity
}

const exactFidelity = 9

// parseEncodings picks the first encoding in the client's preference order
// that suits format, and reads the quality and compression levels.
func parseEncodings(encs []int32, format PixelFormat) encoderSettings {
	set := encoderSettings{encoding: encodingRaw, quality: -1, compress: -1}
	picked := false
	for _, enc := range encs {
		switch {
		case enc >= encodingQualityLevel0 && enc <= encodingQualityLevel0+9:
			set.quality = int(enc - encodingQualityLevel0)
		case enc >= encodingCompressLevel0 && enc <= encodingCompressLevel0+9:
			set.compress = int(enc - encodingCompressLevel0)
		case picked:
		case enc == encodingTight && format.tightCompatible():
			set.encoding, picked = encodingTight, true
		case enc == encodingZRLE:
			set.encoding, picked = encodingZRLE, true
		case enc == encodingRaw:
			set.encoding, picked = encodingRaw, true
		}
	}
	return set
}

// zWindow is how far back a deflate stream may refer.
const zWindow = 32768

// zstream is one persistent zlib stream. Each call ends with a sync flush,
// so the client can decode a rectangle as soon as it arrives.
//
// The stream is never restarted, though Tight has a way to say it was.
// noVNC's inflater keeps no history for a stream once it is told of a
// restart (its copy of pako leaves the window size at zero), and fails
// on the first reference back into an earlier rectangle. Every NomadVNC
// viewer is noVNC, and each changes the compression level along with
// the quality.
type zstream struct {
	buf   bytes.Buffer
	w     *flate.Writer
	level int
	// history ends with the last zWindow bytes compressed: what a writer
	// taking over mid-stream must know the client still holds.
	history []byte
}

// compress appends data's compressed form to dst. A change of level takes
// effect without a break in the stream: a new deflate writer takes over
// at the flush boundary, primed with the stream's recent history.
func (z *zstream) compress(dst, data []byte, level int) []byte {
	if z.w == nil {
		// zlib header: deflate with a 32 KB window, no preset dictionary.
		z.buf.Write([]byte{0x78, 0x9c})
	}
	if z.w == nil || z.level != level {
		dict := z.history
		if len(dict) > zWindow {
			dict = dict[len(dict)-zWindow:]
		}
		w, err := flate.NewWriterDict(&z.buf, level, dict)
		if err != nil {
			w, _ = flate.NewWriterDict(&z.buf, flate.DefaultCompression, dict)
		}
		z.w, z.level = w, level
	}
	_, _ = z.w.Write(data)
	_ = z.w.Flush()
	dst = append(dst, z.buf.Bytes()...)
	z.buf.Reset()

	z.history = append(z.history, data...)
	if len(z.history) > 2*zWindow {
		// Drop all but the window now and then, not on every call.
		z.history = z.history[:copy(z.history, z.history[len(z.history)-zWindow:])]
	}
	return dst
}

// parallelFor runs fn(0..n-1) across the CPUs.
func parallelFor(n int, fn func(i int)) {
	workers := min(runtime.GOMAXPROCS(0), n)
	if workers <= 1 {
		for i := 0; i < n; i++ {
			fn(i)
		}
		return
	}
	var next atomic.Int64
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				i := int(next.Add(1) - 1)
				if i >= n {
					return
				}
				fn(i)
			}
		}()
	}
	wg.Wait()
}

func appendRectHeader(dst []byte, r Rect, encoding int32) []byte {
	dst = binary.BigEndian.AppendUint16(dst, uint16(r.X))
	dst = binary.BigEndian.AppendUint16(dst, uint16(r.Y))
	dst = binary.BigEndian.AppendUint16(dst, uint16(r.W))
	dst = binary.BigEndian.AppendUint16(dst, uint16(r.H))
	return binary.BigEndian.AppendUint32(dst, uint32(encoding))
}

// palette collects up to paletteMax distinct values. full reports that a
// value beyond the limit was seen.
type palette struct {
	colors [paletteMax]uint32
	n      int
	full   bool
}

func (p *palette) add(c uint32) {
	for i := 0; i < p.n; i++ {
		if p.colors[i] == c {
			return
		}
	}
	if p.n == paletteMax {
		p.full = true
		return
	}
	p.colors[p.n] = c
	p.n++
}

func (p *palette) index(c uint32) int {
	for i := 0; i < p.n; i++ {
		if p.colors[i] == c {
			return i
		}
	}
	return 0
}

/* ----- ZRLE ----- */

type zrleEncoder struct {
	stream zstream
	level  int
}

// encode appends one ZRLE rectangle per rect. The zlib level is fixed by
// the first update.
func (e *zrleEncoder) encode(dst []byte, src []byte, width int, rects []Rect, format PixelFormat, level int) []byte {
	if e.stream.w == nil {
		e.level = level
	}
	payloads := make([][]byte, len(rects))
	parallelFor(len(rects), func(i int) {
		payloads[i] = zrleRect(nil, src, width, rects[i], format)
	})
	for i, r := range rects {
		dst = appendRectHeader(dst, r, encodingZRLE)
		lenAt := len(dst)
		dst = append(dst, 0, 0, 0, 0)
		dst = e.stream.compress(dst, payloads[i], e.level)
		binary.BigEndian.PutUint32(dst[lenAt:], uint32(len(dst)-lenAt-4))
	}
	return dst
}

// zrleRect writes the uncompressed ZRLE data for r: 64x64 tiles, each solid,
// a packed palette, or raw.
func zrleRect(dst, src []byte, width int, r Rect, format PixelFormat) []byte {
	cpixel := format.compactPixelSize()
	tile := make([]uint32, 0, TileSize*TileSize)
	for ty := r.Y; ty < r.Y+r.H; ty += TileSize {
		th := min(TileSize, r.Y+r.H-ty)
		for tx := r.X; tx < r.X+r.W; tx += TileSize {
			tw := min(TileSize, r.X+r.W-tx)
			tile = tile[:0]
			var pal palette
			for y := ty; y < ty+th; y++ {
				row := (y*width + tx) * 4
				for x := 0; x < tw; x++ {
					px := format.pixel(src[row+2], src[row+1], src[row])
					tile = append(tile, px)
					if !pal.full {
						pal.add(px)
					}
					row += 4
				}
			}
			switch {
			case pal.n == 1:
				dst = append(dst, 1)
				dst = format.appendPixel(dst, pal.colors[0], cpixel)
			case !pal.full:
				dst = append(dst, byte(pal.n))
				for i := 0; i < pal.n; i++ {
					dst = format.appendPixel(dst, pal.colors[i], cpixel)
				}
				bits := 4
				if pal.n <= 2 {
					bits = 1
				} else if pal.n <= 4 {
					bits = 2
				}
				dst = appendPackedIndices(dst, tile, tw, th, bits, &pal)
			default:
				dst = append(dst, 0)
				for _, px := range tile {
					dst = format.appendPixel(dst, px, cpixel)
				}
			}
		}
	}
	return dst
}

// appendPackedIndices writes palette indices bits wide, most significant
// bit first, each row padded to a whole byte (ZRLE and Tight agree).
func appendPackedIndices(dst []byte, pixels []uint32, w, h, bits int, pal *palette) []byte {
	for y := 0; y < h; y++ {
		var cur byte
		used := 0
		for x := 0; x < w; x++ {
			cur |= byte(pal.index(pixels[y*w+x])) << (8 - bits - used)
			used += bits
			if used == 8 {
				dst = append(dst, cur)
				cur, used = 0, 0
			}
		}
		if used > 0 {
			dst = append(dst, cur)
		}
	}
	return dst
}

/* ----- Tight ----- */

type tightEncoder struct {
	streams [4]zstream
}

const (
	tightStreamCopy    = 0
	tightStreamMono    = 1
	tightStreamPalette = 2
)

// tightPiece is one Tight rectangle, prepared in parallel. Fill and JPEG
// pieces are finished; palette and copy pieces still need their zlib step,
// which must run in order on the connection's streams.
type tightPiece struct {
	rect   Rect
	jpeg   bool
	pal    *palette // colors of a single tile, for fill/palette/copy
	done   []byte   // complete body after the rect header
	stream int
	head   []byte // control byte and filter data, before the zlib data
	raw    []byte // data to compress
}

// encode appends Tight rectangles for the changed tiles. Each tile becomes a
// fill, a palette, a JPEG (lossy quality only), or zlib-compressed pixels;
// runs of JPEG tiles merge into strips so headers stay small.
// The returned rects were sent as JPEG, at set.quality.
func (e *tightEncoder) encode(dst []byte, src []byte, width int, tiles []Rect, set encoderSettings) ([]byte, int, []Rect) {
	kinds := make([]palette, len(tiles))
	parallelFor(len(tiles), func(i int) {
		kinds[i] = tightColors(src, width, tiles[i])
	})

	var pieces []tightPiece
	for i := 0; i < len(tiles); i++ {
		if set.lossy() && kinds[i].full {
			span := tiles[i]
			for j := i + 1; j < len(tiles) && j-i < spanMaxTiles; j++ {
				next := tiles[j]
				if !kinds[j].full || next.Y != span.Y || next.H != span.H || next.X != span.X+span.W {
					break
				}
				span.W += next.W
				i = j
			}
			pieces = append(pieces, tightPiece{rect: span, jpeg: true})
			continue
		}
		pieces = append(pieces, tightPiece{rect: tiles[i], pal: &kinds[i]})
	}

	parallelFor(len(pieces), func(i int) {
		p := &pieces[i]
		if p.jpeg {
			p.done = tightJPEG(src, width, p.rect, jpegQuality[set.quality])
			return
		}
		*p = tightBasic(src, width, p.rect, p.pal)
	})

	level := set.zlibLevel()
	for i := range pieces {
		p := &pieces[i]
		dst = appendRectHeader(dst, p.rect, encodingTight)
		if p.done != nil {
			dst = append(dst, p.done...)
			continue
		}
		if len(p.raw) < 12 {
			// Tight sends under 12 bytes uncompressed.
			dst = append(dst, p.head...)
			dst = append(dst, p.raw...)
			continue
		}
		// The low four bits of the control byte would restart streams.
		// They stay clear: see zstream.
		body := e.streams[p.stream].compress(nil, p.raw, level)
		dst = append(dst, p.head...)
		dst = appendCompactLength(dst, len(body))
		dst = append(dst, body...)
	}
	var lossy []Rect
	for _, p := range pieces {
		if p.jpeg {
			lossy = append(lossy, p.rect)
		}
	}
	return dst, len(pieces), lossy
}

// tightColors collects up to paletteMax colors (0x00RRGGBB) from r.
func tightColors(src []byte, width int, r Rect) palette {
	var pal palette
	for y := r.Y; y < r.Y+r.H; y++ {
		row := (y*width + r.X) * 4
		for x := 0; x < r.W; x++ {
			pal.add(uint32(src[row+2])<<16 | uint32(src[row+1])<<8 | uint32(src[row]))
			if pal.full {
				return pal
			}
			row += 4
		}
	}
	return pal
}

func appendTPixel(dst []byte, c uint32) []byte {
	return append(dst, byte(c>>16), byte(c>>8), byte(c))
}

// tightBasic prepares a fill, palette, or copy rectangle.
func tightBasic(src []byte, width int, r Rect, pal *palette) tightPiece {
	p := tightPiece{rect: r, pal: pal}
	switch {
	case pal.n == 1:
		p.done = appendTPixel([]byte{0x80}, pal.colors[0])
	case !pal.full:
		bits, stream := 8, tightStreamPalette
		if pal.n == 2 {
			bits, stream = 1, tightStreamMono
		}
		p.stream = stream
		// Explicit filter (0x40), palette filter (1), color count - 1.
		p.head = []byte{byte(stream<<4) | 0x40, 1, byte(pal.n - 1)}
		for i := 0; i < pal.n; i++ {
			p.head = appendTPixel(p.head, pal.colors[i])
		}
		pixels := make([]uint32, 0, r.W*r.H)
		for y := r.Y; y < r.Y+r.H; y++ {
			row := (y*width + r.X) * 4
			for x := 0; x < r.W; x++ {
				pixels = append(pixels, uint32(src[row+2])<<16|uint32(src[row+1])<<8|uint32(src[row]))
				row += 4
			}
		}
		if bits == 1 {
			p.raw = appendPackedIndices(nil, pixels, r.W, r.H, 1, pal)
		} else {
			p.raw = make([]byte, len(pixels))
			for i, c := range pixels {
				p.raw[i] = byte(pal.index(c))
			}
		}
	default:
		p.stream = tightStreamCopy
		p.head = []byte{byte(tightStreamCopy << 4)}
		p.raw = make([]byte, 0, r.W*r.H*3)
		for y := r.Y; y < r.Y+r.H; y++ {
			row := (y*width + r.X) * 4
			for x := 0; x < r.W; x++ {
				p.raw = append(p.raw, src[row+2], src[row+1], src[row])
				row += 4
			}
		}
	}
	return p
}

// tightJPEG returns a complete Tight JPEG body for r.
func tightJPEG(src []byte, width int, r Rect, quality int) []byte {
	img := image.NewRGBA(image.Rect(0, 0, r.W, r.H))
	for y := 0; y < r.H; y++ {
		in := ((r.Y+y)*width + r.X) * 4
		out := y * img.Stride
		for x := 0; x < r.W; x++ {
			img.Pix[out] = src[in+2]
			img.Pix[out+1] = src[in+1]
			img.Pix[out+2] = src[in]
			img.Pix[out+3] = 255
			in += 4
			out += 4
		}
	}
	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, &jpeg.Options{Quality: quality})
	body := appendCompactLength([]byte{0x90}, buf.Len())
	return append(body, buf.Bytes()...)
}

// appendCompactLength writes Tight's 1-3 byte length, 7 bits per byte.
func appendCompactLength(dst []byte, n int) []byte {
	b := byte(n & 0x7f)
	if n > 0x7f {
		dst = append(dst, b|0x80)
		b = byte(n >> 7 & 0x7f)
		if n > 0x3fff {
			dst = append(dst, b|0x80)
			return append(dst, byte(n>>14&0xff))
		}
	}
	return append(dst, b)
}
