package rfb

import "encoding/binary"

// PixelFormat is the 16-byte RFB pixel format, limited to 32-bit true color.
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

func (f PixelFormat) supported() bool {
	return f.BitsPerPixel == 32 && f.TrueColor && f.RedMax > 0 && f.GreenMax > 0 && f.BlueMax > 0
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

	native := !format.BigEndian &&
		format.RedMax == 255 && format.GreenMax == 255 && format.BlueMax == 255 &&
		format.RedShift == 0 && format.GreenShift == 8 && format.BlueShift == 16

	for y := rect.Y; y < rect.Y+rect.H; y++ {
		row := (y*width + rect.X) * 4
		for x := 0; x < rect.W; x++ {
			b := src[row]
			g := src[row+1]
			r := src[row+2]
			row += 4
			if native {
				dst = append(dst, r, g, b, 0)
				continue
			}
			px := (scale(r, format.RedMax) << format.RedShift) |
				(scale(g, format.GreenMax) << format.GreenShift) |
				(scale(b, format.BlueMax) << format.BlueShift)
			var packed [4]byte
			if format.BigEndian {
				binary.BigEndian.PutUint32(packed[:], px)
			} else {
				binary.LittleEndian.PutUint32(packed[:], px)
			}
			dst = append(dst, packed[:]...)
		}
	}
	return dst
}

func scale(channel byte, max uint16) uint32 {
	if max == 255 {
		return uint32(channel)
	}
	return uint32(channel) * uint32(max) / 255
}
