package main

import (
	"fmt"
	"unsafe"

	"github.com/nomadvnc/nomadvnc/go-core/internal/rfb"
	"golang.org/x/sys/windows"
)

var (
	user32                     = windows.NewLazySystemDLL("user32.dll")
	gdi32                      = windows.NewLazySystemDLL("gdi32.dll")
	procGetDC                  = user32.NewProc("GetDC")
	procReleaseDC              = user32.NewProc("ReleaseDC")
	procGetSystemMetrics       = user32.NewProc("GetSystemMetrics")
	procSetProcessDPIAware     = user32.NewProc("SetProcessDPIAware")
	procCreateCompatibleDC     = gdi32.NewProc("CreateCompatibleDC")
	procCreateCompatibleBitmap = gdi32.NewProc("CreateCompatibleBitmap")
	procSelectObject           = gdi32.NewProc("SelectObject")
	procBitBlt                 = gdi32.NewProc("BitBlt")
	procGetDIBits              = gdi32.NewProc("GetDIBits")
	procDeleteObject           = gdi32.NewProc("DeleteObject")
	procDeleteDC               = gdi32.NewProc("DeleteDC")
	procEnumWindows            = user32.NewProc("EnumWindows")
	procIsWindowVisible        = user32.NewProc("IsWindowVisible")
	procIsIconic               = user32.NewProc("IsIconic")
	procPrintWindow            = user32.NewProc("PrintWindow")
)

const (
	smCXScreen = 0
	smCYScreen = 1
	srcCopy    = 0x00CC0020
	captureBlt = 0x40000000
	biRGB      = 0
	dibRGB     = 0
)

type bitmapInfoHeader struct {
	Size          uint32
	Width         int32
	Height        int32
	Planes        uint16
	BitCount      uint16
	Compression   uint32
	SizeImage     uint32
	XPelsPerMeter int32
	YPelsPerMeter int32
	ClrUsed       uint32
	ClrImportant  uint32
}

func enableDPIAware() {
	_, _, _ = procSetProcessDPIAware.Call()
}

func captureGDI() (rfb.Frame, error) {
	cx, _, _ := procGetSystemMetrics.Call(smCXScreen)
	cy, _, _ := procGetSystemMetrics.Call(smCYScreen)
	width := int(cx)
	height := int(cy)
	if width < 640 || height < 480 || width > 8192 || height > 8192 {
		return rfb.Frame{}, fmt.Errorf("screen size %dx%d", width, height)
	}

	screen, _, _ := procGetDC.Call(0)
	if screen == 0 {
		return rfb.Frame{}, fmt.Errorf("GetDC failed")
	}
	defer procReleaseDC.Call(0, screen)

	mem, _, _ := procCreateCompatibleDC.Call(screen)
	if mem == 0 {
		return rfb.Frame{}, fmt.Errorf("CreateCompatibleDC failed")
	}
	defer procDeleteDC.Call(mem)

	bitmap, _, _ := procCreateCompatibleBitmap.Call(screen, uintptr(width), uintptr(height))
	if bitmap == 0 {
		return rfb.Frame{}, fmt.Errorf("CreateCompatibleBitmap failed")
	}
	defer procDeleteObject.Call(bitmap)

	old, _, _ := procSelectObject.Call(mem, bitmap)
	defer procSelectObject.Call(mem, old)

	if r, _, _ := procBitBlt.Call(mem, 0, 0, uintptr(width), uintptr(height), screen, 0, 0, srcCopy|captureBlt); r == 0 {
		return rfb.Frame{}, fmt.Errorf("BitBlt failed")
	}

	header := bitmapInfoHeader{
		Size:        uint32(unsafe.Sizeof(bitmapInfoHeader{})),
		Width:       int32(width),
		Height:      -int32(height),
		Planes:      1,
		BitCount:    32,
		Compression: biRGB,
		SizeImage:   uint32(width * height * 4),
	}
	pix := make([]byte, width*height*4)
	got, _, _ := procGetDIBits.Call(
		mem,
		bitmap,
		0,
		uintptr(height),
		uintptr(unsafe.Pointer(&pix[0])),
		uintptr(unsafe.Pointer(&header)),
		dibRGB,
	)
	if got == 0 {
		return rfb.Frame{}, fmt.Errorf("GetDIBits failed")
	}
	// BitBlt of the screen often returns only the wallpaper on Windows 10
	// and 11. Paint each visible window on top of that background.
	compositeWindows(pix, width, height, mem)
	return rfb.Frame{Width: width, Height: height, Pix: pix}, nil
}

func visibleWindowCount() int {
	return len(visibleWindows())
}

func visibleWindows() []uintptr {
	var hwnds []uintptr
	cb := windows.NewCallback(func(hwnd, _ uintptr) uintptr {
		visible, _, _ := procIsWindowVisible.Call(hwnd)
		if visible == 0 {
			return 1
		}
		iconic, _, _ := procIsIconic.Call(hwnd)
		if iconic != 0 {
			return 1
		}
		hwnds = append(hwnds, hwnd)
		return 1
	})
	_, _, _ = procEnumWindows.Call(cb, 0)
	return hwnds
}

func compositeWindows(pix []byte, width, height int, screenDC uintptr) {
	hwnds := visibleWindows()
	for i := len(hwnds) - 1; i >= 0; i-- {
		paintWindow(pix, width, height, screenDC, hwnds[i])
	}
}

func paintWindow(pix []byte, screenW, screenH int, screenDC, hwnd uintptr) {
	var rect struct {
		Left, Top, Right, Bottom int32
	}
	if r, _, _ := procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&rect))); r == 0 {
		return
	}
	winW := int(rect.Right - rect.Left)
	winH := int(rect.Bottom - rect.Top)
	if winW <= 0 || winH <= 0 || winW > 8192 || winH > 8192 {
		return
	}
	mem, _, _ := procCreateCompatibleDC.Call(screenDC)
	if mem == 0 {
		return
	}
	defer procDeleteDC.Call(mem)
	bitmap, _, _ := procCreateCompatibleBitmap.Call(screenDC, uintptr(winW), uintptr(winH))
	if bitmap == 0 {
		return
	}
	defer procDeleteObject.Call(bitmap)
	old, _, _ := procSelectObject.Call(mem, bitmap)
	defer procSelectObject.Call(mem, old)
	// PW_RENDERFULLCONTENT draws the window even when Desktop Window
	// Manager is compositing it.
	if r, _, _ := procPrintWindow.Call(hwnd, mem, 2); r == 0 {
		return
	}
	header := bitmapInfoHeader{
		Size:        uint32(unsafe.Sizeof(bitmapInfoHeader{})),
		Width:       int32(winW),
		Height:      -int32(winH),
		Planes:      1,
		BitCount:    32,
		Compression: biRGB,
		SizeImage:   uint32(winW * winH * 4),
	}
	raw := make([]byte, winW*winH*4)
	if got, _, _ := procGetDIBits.Call(mem, bitmap, 0, uintptr(winH), uintptr(unsafe.Pointer(&raw[0])), uintptr(unsafe.Pointer(&header)), dibRGB); got == 0 {
		return
	}
	dstX0 := max(int(rect.Left), 0)
	dstY0 := max(int(rect.Top), 0)
	dstX1 := min(int(rect.Right), screenW)
	dstY1 := min(int(rect.Bottom), screenH)
	for y := dstY0; y < dstY1; y++ {
		srcY := y - int(rect.Top)
		for x := dstX0; x < dstX1; x++ {
			srcX := x - int(rect.Left)
			src := (srcY*winW + srcX) * 4
			dst := (y*screenW + x) * 4
			copy(pix[dst:dst+4], raw[src:src+4])
		}
	}
}
