package rfb

import "encoding/binary"

// PixelFormat is the 16-byte RFB pixel format.
type PixelFormat struct {
	BitsPerPixel uint8
	Depth        uint8
	BigEndian    bool
	TrueColor    bool
	RedMax       uint16
	GreenMax     uint16
	BlueMax      uint16
	RedShift     uint8
	GreenShift   uint8
	BlueShift    uint8
}

// DefaultPixelFormat matches the format noVNC requests: little-endian
// 32-bit true color, red in the first byte.
func DefaultPixelFormat() PixelFormat {
	return PixelFormat{
		BitsPerPixel: 32,
		Depth:        24,
		TrueColor:    true,
		RedMax:       255,
		GreenMax:     255,
		BlueMax:      255,
		RedShift:     0,
		GreenShift:   8,
		BlueShift:    16,
	}
}

// supported reports whether the server can encode pixels in f: true
// color at 8, 16 or 32 bits per pixel, or an 8-bit color map, which the
// server fills with a fixed palette (see colorMapEntries).
func (f PixelFormat) supported() bool {
	if f.BitsPerPixel != 8 && f.BitsPerPixel != 16 && f.BitsPerPixel != 32 {
		return false
	}
	if !f.TrueColor {
		return f.BitsPerPixel == 8
	}
	return channelFits(f.RedMax, f.RedShift, f.BitsPerPixel) &&
		channelFits(f.GreenMax, f.GreenShift, f.BitsPerPixel) &&
		channelFits(f.BlueMax, f.BlueShift, f.BitsPerPixel)
}

func channelFits(max uint16, shift, bits uint8) bool {
	return max > 0 && uint64(max)<<shift < 1<<bits
}

// appendWire writes the 16-byte pixel format.
func (f PixelFormat) appendWire(dst []byte) []byte {
	var big byte
	if f.BigEndian {
		big = 1
	}
	var trueColor byte
	if f.TrueColor {
		trueColor = 1
	}
	dst = append(dst, f.BitsPerPixel, f.Depth, big, trueColor)
	dst = binary.BigEndian.AppendUint16(dst, f.RedMax)
	dst = binary.BigEndian.AppendUint16(dst, f.GreenMax)
	dst = binary.BigEndian.AppendUint16(dst, f.BlueMax)
	dst = append(dst, f.RedShift, f.GreenShift, f.BlueShift, 0, 0, 0)
	return dst
}

func pixelFormatFromWire(buf []byte) PixelFormat {
	return PixelFormat{
		BitsPerPixel: buf[0],
		Depth:        buf[1],
		BigEndian:    buf[2] != 0,
		TrueColor:    buf[3] != 0,
		RedMax:       binary.BigEndian.Uint16(buf[4:6]),
		GreenMax:     binary.BigEndian.Uint16(buf[6:8]),
		BlueMax:      binary.BigEndian.Uint16(buf[8:10]),
		RedShift:     buf[10],
		GreenShift:   buf[11],
		BlueShift:    buf[12],
	}
}

// appendRawRect writes one Raw-encoded rectangle. src is top-down BGRA.
func appendRawRect(dst []byte, src []byte, width int, rect Rect, format PixelFormat) []byte {
	dst = binary.BigEndian.AppendUint16(dst, uint16(rect.X))
	dst = binary.BigEndian.AppendUint16(dst, uint16(rect.Y))
	dst = binary.BigEndian.AppendUint16(dst, uint16(rect.W))
	dst = binary.BigEndian.AppendUint16(dst, uint16(rect.H))
	dst = binary.BigEndian.AppendUint32(dst, 0) // raw encoding

	if format.isNative() {
		for y := rect.Y; y < rect.Y+rect.H; y++ {
			row := (y*width + rect.X) * 4
			for x := 0; x < rect.W; x++ {
				dst = append(dst, src[row+2], src[row+1], src[row], 0)
				row += 4
			}
		}
		return dst
	}
	for y := rect.Y; y < rect.Y+rect.H; y++ {
		row := (y*width + rect.X) * 4
		for x := 0; x < rect.W; x++ {
			dst = format.appendPixel(dst, format.pixel(src[row+2], src[row+1], src[row]), int(format.BitsPerPixel/8))
			row += 4
		}
	}
	return dst
}

// isNative reports whether f is the little-endian RGBX layout noVNC uses,
// which needs no per-channel conversion.
func (f PixelFormat) isNative() bool {
	return f.BitsPerPixel == 32 && f.TrueColor && !f.BigEndian &&
		f.RedMax == 255 && f.GreenMax == 255 && f.BlueMax == 255 &&
		f.RedShift == 0 && f.GreenShift == 8 && f.BlueShift == 16
}

// pixel converts one color to its value in f.
func (f PixelFormat) pixel(r, g, b byte) uint32 {
	if !f.TrueColor {
		return colorMapIndex(r, g, b)
	}
	return (scale(r, f.RedMax) << f.RedShift) |
		(scale(g, f.GreenMax) << f.GreenShift) |
		(scale(b, f.BlueMax) << f.BlueShift)
}

// appendPixel writes px as n bytes in f's byte order. n is the full pixel
// size, or 3 for ZRLE's compressed pixel (the three bytes that carry color).
func (f PixelFormat) appendPixel(dst []byte, px uint32, n int) []byte {
	switch n {
	case 1:
		return append(dst, byte(px))
	case 2:
		if f.BigEndian {
			return binary.BigEndian.AppendUint16(dst, uint16(px))
		}
		return binary.LittleEndian.AppendUint16(dst, uint16(px))
	case 3:
		if f.BigEndian {
			return append(dst, byte(px>>16), byte(px>>8), byte(px))
		}
		return append(dst, byte(px), byte(px>>8), byte(px>>16))
	default:
		if f.BigEndian {
			return binary.BigEndian.AppendUint32(dst, px)
		}
		return binary.LittleEndian.AppendUint32(dst, px)
	}
}

// compactPixelSize is ZRLE's CPIXEL size: 3 bytes when a 32-bit true-color
// pixel carries all its color in the low 24 bits, else the full size.
func (f PixelFormat) compactPixelSize() int {
	if f.BitsPerPixel == 32 && f.TrueColor && f.Depth <= 24 &&
		uint64(f.RedMax)<<f.RedShift < 1<<24 &&
		uint64(f.GreenMax)<<f.GreenShift < 1<<24 &&
		uint64(f.BlueMax)<<f.BlueShift < 1<<24 {
		return 3
	}
	return int(f.BitsPerPixel / 8)
}

// tightCompatible reports whether Tight's 3-byte TPIXEL can carry f: 32-bit
// true color with 8 bits per channel, the only format Tight viewers use.
func (f PixelFormat) tightCompatible() bool {
	return f.BitsPerPixel == 32 && f.TrueColor && f.Depth == 24 &&
		f.RedMax == 255 && f.GreenMax == 255 && f.BlueMax == 255
}

func scale(channel byte, max uint16) uint32 {
	if max == 255 {
		return uint32(channel)
	}
	return (uint32(channel)*uint32(max) + 127) / 255
}

// Color-map clients get a fixed 256-color palette: 3 bits red, 3 bits
// green, 2 bits blue (index bits bbgggrrr).
func colorMapIndex(r, g, b byte) uint32 {
	return uint32(r>>5) | uint32(g>>5)<<3 | uint32(b>>6)<<6
}

// colorMapEntries is the SetColorMapEntries message for the fixed palette.
func colorMapEntries() []byte {
	msg := []byte{1, 0}
	msg = binary.BigEndian.AppendUint16(msg, 0)   // first color
	msg = binary.BigEndian.AppendUint16(msg, 256) // number of colors
	for i := 0; i < 256; i++ {
		msg = binary.BigEndian.AppendUint16(msg, uint16((i&7)*65535/7))
		msg = binary.BigEndian.AppendUint16(msg, uint16((i>>3&7)*65535/7))
		msg = binary.BigEndian.AppendUint16(msg, uint16((i>>6&3)*65535/3))
	}
	return msg
}
