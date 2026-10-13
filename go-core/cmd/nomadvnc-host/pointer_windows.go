package main

import (
	"errors"
	"unsafe"

	"github.com/nomadvnc/nomadvnc/go-core/internal/hostcore"
	"github.com/nomadvnc/nomadvnc/go-core/internal/rfb"
	"golang.org/x/sys/windows"
)

var (
	procGetCursorInfo = user32.NewProc("GetCursorInfo")
	procGetIconInfo   = user32.NewProc("GetIconInfo")
	procGetObject     = gdi32.NewProc("GetObjectW")
)

// cursorInfo is CURSORINFO: size, flags, cursor handle, screen position.
type cursorInfo struct {
	Size   uint32
	Flags  uint32
	Cursor uintptr
	X, Y   int32
}

const cursorShowing = 1

// iconInfo is ICONINFO.
type iconInfo struct {
	IsIcon   int32
	HotX     uint32
	HotY     uint32
	MaskBits windows.Handle
	Color    windows.Handle
}

// bitmapObject is BITMAP, as GetObject fills it.
type bitmapObject struct {
	Type       int32
	Width      int32
	Height     int32
	WidthBytes int32
	Planes     uint16
	BitsPixel  uint16
	Bits       uintptr
}

// Pointer state, used only on the capture worker's thread.
var (
	pointerHandle uintptr
	pointerShape  *rfb.CursorShape
	pointerID     uint64
)

// currentPointer reports where the pointer is and what it looks like.
// Shapes are read only when the cursor handle changes.
func currentPointer() *rfb.Cursor {
	info := cursorInfo{Size: uint32(unsafe.Sizeof(cursorInfo{}))}
	if r, _, _ := procGetCursorInfo.Call(uintptr(unsafe.Pointer(&info))); r == 0 {
		return &rfb.Cursor{}
	}
	if info.Flags&cursorShowing == 0 || info.Cursor == 0 {
		return &rfb.Cursor{X: int(info.X), Y: int(info.Y)}
	}
	if info.Cursor != pointerHandle || pointerShape == nil {
		shape, err := readCursorShape(info.Cursor)
		if err != nil {
			return &rfb.Cursor{X: int(info.X), Y: int(info.Y)}
		}
		pointerID++
		shape.ID = pointerID
		pointerHandle, pointerShape = info.Cursor, shape
	}
	return &rfb.Cursor{Visible: true, X: int(info.X), Y: int(info.Y), Shape: pointerShape}
}

// readCursorShape turns a cursor's bitmaps into straight-alpha BGRA.
func readCursorShape(cursor uintptr) (*rfb.CursorShape, error) {
	var ii iconInfo
	if r, _, _ := procGetIconInfo.Call(cursor, uintptr(unsafe.Pointer(&ii))); r == 0 {
		return nil, errors.New("GetIconInfo failed")
	}
	if ii.MaskBits != 0 {
		defer procDeleteObject.Call(uintptr(ii.MaskBits))
	}
	if ii.Color != 0 {
		defer procDeleteObject.Call(uintptr(ii.Color))
	}
	var bm bitmapObject
	if r, _, _ := procGetObject.Call(uintptr(ii.MaskBits), unsafe.Sizeof(bm), uintptr(unsafe.Pointer(&bm))); r == 0 {
		return nil, errors.New("GetObject failed")
	}
	w, maskH := int(bm.Width), int(bm.Height)
	if w <= 0 || maskH <= 0 || w > 256 || maskH > 512 {
		return nil, errors.New("unexpected cursor size")
	}
	mono := ii.Color == 0
	h := maskH
	if mono {
		// A monochrome cursor stacks its AND mask over its XOR mask.
		h = maskH / 2
	}
	mask, err := bitmapBGRA(ii.MaskBits, w, maskH)
	if err != nil {
		return nil, err
	}
	var color []byte
	if !mono {
		if color, err = bitmapBGRA(ii.Color, w, h); err != nil {
			return nil, err
		}
	}
	return &rfb.CursorShape{
		Width: w, Height: h, HotX: int(ii.HotX), HotY: int(ii.HotY),
		Pix: hostcore.CursorPixels(mask, color, w, h),
	}, nil
}

// bitmapBGRA reads a bitmap as top-down 32-bit BGRA.
func bitmapBGRA(bitmap windows.Handle, w, h int) ([]byte, error) {
	screen, _, _ := procGetDC.Call(0)
	if screen == 0 {
		return nil, errors.New("GetDC failed")
	}
	defer procReleaseDC.Call(0, screen)
	header := bitmapInfoHeader{
		Width:    int32(w),
		Height:   -int32(h),
		Planes:   1,
		BitCount: 32,
	}
	header.Size = uint32(unsafe.Sizeof(header))
	// BITMAPINFO: the header, then room for a color table GetDIBits may write.
	var info struct {
		Header bitmapInfoHeader
		Colors [256]uint32
	}
	info.Header = header
	buf := make([]byte, w*h*4)
	if r, _, _ := procGetDIBits.Call(screen, uintptr(bitmap), 0, uintptr(h),
		uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&info)), dibRGB); r == 0 {
		return nil, errors.New("GetDIBits failed")
	}
	return buf, nil
}
