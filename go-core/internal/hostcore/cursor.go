package hostcore

// CursorPixels combines a cursor's masks into straight-alpha BGRA. mask is
// the AND mask (for monochrome cursors followed by the XOR mask); color is
// nil for monochrome cursors. Pixels that invert the screen, like the text
// I-beam's, can't be sent as an image: they become black with a white
// outline, which shows on light and dark backgrounds alike.
func CursorPixels(mask, color []byte, w, h int) []byte {
	pix := make([]byte, w*h*4)
	invert := make([]bool, w*h)
	alpha := false
	for i := 3; i < len(color); i += 4 {
		if color[i] != 0 {
			alpha = true
			break
		}
	}
	for i := 0; i < w*h; i++ {
		and := mask[i*4] != 0
		p := pix[i*4 : i*4+4]
		if color == nil {
			xor := mask[(w*h+i)*4] != 0
			switch {
			case !and:
				v := byte(0)
				if xor {
					v = 255
				}
				p[0], p[1], p[2], p[3] = v, v, v, 255
			case xor:
				invert[i] = true
			}
			continue
		}
		c := color[i*4 : i*4+4]
		switch {
		case alpha:
			copy(p, c)
		case !and:
			p[0], p[1], p[2], p[3] = c[0], c[1], c[2], 255
		case c[0]|c[1]|c[2] != 0:
			invert[i] = true
		}
	}
	for i, inv := range invert {
		if inv {
			p := pix[i*4 : i*4+4]
			p[0], p[1], p[2], p[3] = 0, 0, 0, 255
		}
	}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			i := y*w + x
			if pix[i*4+3] != 0 {
				continue
			}
			if (x > 0 && invert[i-1]) || (x < w-1 && invert[i+1]) ||
				(y > 0 && invert[i-w]) || (y < h-1 && invert[i+w]) {
				p := pix[i*4 : i*4+4]
				p[0], p[1], p[2], p[3] = 255, 255, 255, 255
			}
		}
	}
	return pix
}
