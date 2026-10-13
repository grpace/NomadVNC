package rfb

// encodingCursor is the pseudo-encoding a viewer lists when it can draw
// the pointer itself from a shape the server sends.
const encodingCursor = -239

// Cursor is the mouse pointer. A capture that sets Frame.Cursor leaves the
// pointer out of Frame.Pix: viewers that draw it locally get only its
// shape, so moving the mouse costs no screen updates and shows without a
// round trip; the server draws it into the picture for the rest.
type Cursor struct {
	Visible bool
	// X and Y are where the hotspot is on the screen.
	X, Y  int
	Shape *CursorShape
}

// CursorShape is a pointer image. Pix is BGRA with straight alpha.
type CursorShape struct {
	Width, Height int
	HotX, HotY    int
	Pix           []byte
	// ID changes whenever the shape does, so it is sent only then.
	ID uint64
}

// cursorKey identifies what a drawn-in pointer looks like and where.
type cursorKey struct {
	visible bool
	x, y    int
	id      uint64
}

func keyOf(c *Cursor) cursorKey {
	if c == nil || !c.Visible || c.Shape == nil {
		return cursorKey{}
	}
	return cursorKey{visible: true, x: c.X, y: c.Y, id: c.Shape.ID}
}

// composite copies pix into dst and blends the pointer over it.
func composite(dst, pix []byte, width, height int, c *Cursor) []byte {
	dst = append(dst[:0], pix...)
	if c == nil || !c.Visible || c.Shape == nil {
		return dst
	}
	s := c.Shape
	x0, y0 := c.X-s.HotX, c.Y-s.HotY
	for y := 0; y < s.Height; y++ {
		sy := y0 + y
		if sy < 0 || sy >= height {
			continue
		}
		for x := 0; x < s.Width; x++ {
			sx := x0 + x
			if sx < 0 || sx >= width {
				continue
			}
			src := s.Pix[(y*s.Width+x)*4:]
			a := uint32(src[3])
			if a == 0 {
				continue
			}
			d := dst[(sy*width+sx)*4:]
			for i := 0; i < 3; i++ {
				d[i] = byte((uint32(src[i])*a + uint32(d[i])*(255-a) + 127) / 255)
			}
		}
	}
	return dst
}

// appendCursorRect writes a Cursor pseudo-rectangle: pixels in the
// client's format, then a bitmask of the opaque ones. A hidden pointer
// is an empty shape.
func appendCursorRect(dst []byte, c *Cursor, format PixelFormat) []byte {
	if c == nil || !c.Visible || c.Shape == nil {
		return appendRectHeader(dst, Rect{}, encodingCursor)
	}
	s := c.Shape
	dst = appendRectHeader(dst, Rect{X: s.HotX, Y: s.HotY, W: s.Width, H: s.Height}, encodingCursor)
	n := int(format.BitsPerPixel / 8)
	for i := 0; i < s.Width*s.Height; i++ {
		p := s.Pix[i*4:]
		dst = format.appendPixel(dst, format.pixel(p[2], p[1], p[0]), n)
	}
	rowBytes := (s.Width + 7) / 8
	for y := 0; y < s.Height; y++ {
		row := make([]byte, rowBytes)
		for x := 0; x < s.Width; x++ {
			if s.Pix[(y*s.Width+x)*4+3] >= 128 {
				row[x/8] |= 0x80 >> (x % 8)
			}
		}
		dst = append(dst, row...)
	}
	return dst
}
