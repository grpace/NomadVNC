package rfb

// TileSize is the width and height of a raw rectangle sent for a changed
// region. Smaller tiles mean less unchanged data on the wire.
const TileSize = 64

// Rect is a framebuffer rectangle in pixels.
type Rect struct {
	X, Y, W, H int
}

// DirtyTiles returns the tiles whose pixels differ. A nil or short previous
// frame marks every tile dirty. next is top-down, tightly packed, 4 bytes
// per pixel.
func DirtyTiles(prev, next []byte, width, height int) []Rect {
	if width <= 0 || height <= 0 {
		return nil
	}
	need := width * height * 4
	if len(next) < need {
		return nil
	}
	full := len(prev) < need
	var out []Rect
	for y := 0; y < height; y += TileSize {
		h := TileSize
		if y+h > height {
			h = height - y
		}
		for x := 0; x < width; x += TileSize {
			w := TileSize
			if x+w > width {
				w = width - x
			}
			if full || tileChanged(prev, next, width, x, y, w, h) {
				out = append(out, Rect{X: x, Y: y, W: w, H: h})
			}
		}
	}
	return out
}

func tileChanged(prev, next []byte, width, x, y, w, h int) bool {
	rowBytes := w * 4
	for row := 0; row < h; row++ {
		start := ((y+row)*width + x) * 4
		for i := 0; i < rowBytes; i++ {
			if prev[start+i] != next[start+i] {
				return true
			}
		}
	}
	return false
}
