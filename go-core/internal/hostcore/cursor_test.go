package hostcore

import "testing"

// bgra builds a 32-bit buffer where each value is a gray level.
func bgra(levels ...byte) []byte {
	out := make([]byte, 0, len(levels)*4)
	for _, v := range levels {
		out = append(out, v, v, v, 0)
	}
	return out
}

func alphaAt(pix []byte, i int) byte { return pix[i*4+3] }
func grayAt(pix []byte, i int) byte  { return pix[i*4] }

func TestMonochromeCursorPixels(t *testing.T) {
	// 3x1 cursor. AND row then XOR row:
	// pixel 0: AND 0, XOR 1 -> white; pixel 1: AND 1, XOR 0 -> transparent;
	// pixel 2: AND 1, XOR 1 -> inverts the screen.
	mask := bgra(0, 255, 255, 255, 0, 255)
	pix := CursorPixels(mask, nil, 3, 1)
	if alphaAt(pix, 0) != 255 || grayAt(pix, 0) != 255 {
		t.Fatalf("pixel 0 = %v, want opaque white", pix[0:4])
	}
	// Transparent, but next to an inverting pixel: the white outline.
	if alphaAt(pix, 1) != 255 || grayAt(pix, 1) != 255 {
		t.Fatalf("pixel 1 = %v, want the white outline", pix[4:8])
	}
	if alphaAt(pix, 2) != 255 || grayAt(pix, 2) != 0 {
		t.Fatalf("pixel 2 = %v, want opaque black for an inverting pixel", pix[8:12])
	}
}

func TestColorCursorPixels(t *testing.T) {
	// No alpha in the color bitmap: the AND mask decides.
	mask := bgra(0, 255)
	color := []byte{10, 20, 30, 0, 0, 0, 0, 0}
	pix := CursorPixels(mask, color, 2, 1)
	if pix[0] != 10 || pix[1] != 20 || pix[2] != 30 || pix[3] != 255 {
		t.Fatalf("opaque pixel = %v", pix[0:4])
	}
	if alphaAt(pix, 1) != 0 {
		t.Fatalf("masked pixel = %v, want transparent", pix[4:8])
	}

	// With alpha, the color bitmap's alpha is used as is.
	color = []byte{10, 20, 30, 128, 1, 2, 3, 0}
	pix = CursorPixels(bgra(255, 255), color, 2, 1)
	if alphaAt(pix, 0) != 128 || alphaAt(pix, 1) != 0 {
		t.Fatalf("alpha cursor = %v", pix)
	}
}
