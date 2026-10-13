package main

import (
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

// The setup window's look: a header with the logo and what the host is
// doing, the settings on a card, and a footer for the rarely used
// Uninstall. Colors are the desktop app's
// (apps/desktop/src/renderer/styles.css), light or dark as Windows is set.

var (
	uxtheme = windows.NewLazySystemDLL("uxtheme.dll")
	dwmapi  = windows.NewLazySystemDLL("dwmapi.dll")

	procGetClientRect         = user32.NewProc("GetClientRect")
	procFillRect              = user32.NewProc("FillRect")
	procDrawText              = user32.NewProc("DrawTextW")
	procDrawFocusRect         = user32.NewProc("DrawFocusRect")
	procInvalidateRect        = user32.NewProc("InvalidateRect")
	procEnableWindow          = user32.NewProc("EnableWindow")
	procAdjustWindowRectEx    = user32.NewProc("AdjustWindowRectEx")
	procLoadImage             = user32.NewProc("LoadImageW")
	procCreateSolidBrush      = gdi32.NewProc("CreateSolidBrush")
	procSetBkMode             = gdi32.NewProc("SetBkMode")
	procSetBkColor            = gdi32.NewProc("SetBkColor")
	procSetTextColor          = gdi32.NewProc("SetTextColor")
	procRoundRect             = gdi32.NewProc("RoundRect")
	procSetWindowTheme        = uxtheme.NewProc("SetWindowTheme")
	procDwmSetWindowAttribute = dwmapi.NewProc("DwmSetWindowAttribute")
)

const (
	wmEraseBkgnd     = 0x0014
	wmDrawItem       = 0x002B
	wmGetFont        = 0x0031
	wmCtlColorEdit   = 0x0133
	wmCtlColorBtn    = 0x0135
	wmCtlColorStatic = 0x0138
	stmSetIcon       = 0x0170
	emSetCueBanner   = 0x1501

	ssIcon         = 0x0003
	ssRight        = 0x0002
	bsDefPush      = 0x0001
	bsOwnerDraw    = 0x000B
	odsSelected    = 0x0001
	odsDisabled    = 0x0004
	odsFocus       = 0x0010
	odsNoFocusRect = 0x0200

	bkTransparent     = 1
	nullPen           = 8
	dtCenterVCenter1L = 0x0001 | 0x0004 | 0x0020 // DT_CENTER | DT_VCENTER | DT_SINGLELINE
	imageIcon         = 1

	spiGetHighContrast = 0x0042
	hcfHighContrastOn  = 0x0001
	// dwmUseImmersiveDarkMode gives the title bar the dark colors.
	dwmUseImmersiveDarkMode = 20

	// The layout, in 96 DPI units (see px).
	wizardWidth   = 460
	wizardHeight  = 614
	headerHeight  = 88
	footerHeight  = 56
	dividerY      = 444
	contentMargin = 24
)

// colorRef is a Windows COLORREF, 0x00BBGGRR.
type colorRef uint32

func rgb(r, g, b byte) colorRef {
	return colorRef(r) | colorRef(g)<<8 | colorRef(b)<<16
}

type winRect struct{ Left, Top, Right, Bottom int32 }

// drawItem is DRAWITEMSTRUCT on amd64 and arm64.
type drawItem struct {
	CtlType, CtlID, ItemID, ItemAction, ItemState uint32
	_                                             uint32
	HwndItem                                      uintptr
	HDC                                           uintptr
	Rect                                          winRect
	ItemData                                      uintptr
}

var _ [64]byte = [unsafe.Sizeof(drawItem{})]byte{}

// drawItemFrom reads the pointer Windows passes with WM_DRAWITEM. Going
// through the parameter's address is the conversion go vet accepts for a
// pointer that arrives as an integer.
func drawItemFrom(lparam uintptr) *drawItem {
	return (*drawItem)(*(*unsafe.Pointer)(unsafe.Pointer(&lparam)))
}

// textRole is how a label is colored.
type textRole int

const (
	roleText textRole = iota
	roleMuted
	// roleStatus takes its color from what the host is doing.
	roleStatus
)

type uiTheme struct {
	// plain leaves every color to Windows. High contrast is on, and the
	// colors the person chose must win.
	plain bool
	dark  bool

	band, card, input, border colorRef // header and footer, body, text boxes, lines
	text, muted               colorRef
	accent, accentDown        colorRef
	onAccent                  colorRef
	good, warn                colorRef

	bandBrush, cardBrush, inputBrush, borderBrush uintptr
}

var (
	theme = &uiTheme{plain: true}
	// labelRole and onBand describe the labels and buttons, by window.
	labelRole   = map[uintptr]textRole{}
	onBand      = map[uintptr]bool{}
	statusColor colorRef
)

func loadTheme() *uiTheme {
	t := &uiTheme{}
	if highContrast() {
		t.plain = true
		return t
	}
	t.dark = appsUseDarkTheme()
	if t.dark {
		t.band, t.card, t.input, t.border = rgb(0x08, 0x0C, 0x12), rgb(0x16, 0x1D, 0x2A), rgb(0x0E, 0x14, 0x1E), rgb(0x2C, 0x38, 0x4C)
		t.text, t.muted = rgb(0xF4, 0xF7, 0xFB), rgb(0x9A, 0xAB, 0xC4)
		t.accent, t.accentDown, t.onAccent = rgb(0x3D, 0x8B, 0xFF), rgb(0x2B, 0x6F, 0xD6), rgb(0xFF, 0xFF, 0xFF)
		t.good, t.warn = rgb(0x4A, 0xDE, 0x80), rgb(0xFB, 0xBF, 0x24)
	} else {
		t.band, t.card, t.input, t.border = rgb(0xF2, 0xF4, 0xF8), rgb(0xFF, 0xFF, 0xFF), rgb(0xFF, 0xFF, 0xFF), rgb(0xE2, 0xE8, 0xF0)
		t.text, t.muted = rgb(0x0E, 0x1A, 0x2B), rgb(0x5B, 0x6B, 0x85)
		t.accent, t.accentDown, t.onAccent = rgb(0x0A, 0x6C, 0xFF), rgb(0x08, 0x56, 0xCC), rgb(0xFF, 0xFF, 0xFF)
		t.good, t.warn = rgb(0x15, 0x80, 0x3D), rgb(0xB4, 0x53, 0x09)
	}
	t.bandBrush = solidBrush(t.band)
	t.cardBrush = solidBrush(t.card)
	t.inputBrush = solidBrush(t.input)
	t.borderBrush = solidBrush(t.border)
	return t
}

func solidBrush(c colorRef) uintptr {
	brush, _, _ := procCreateSolidBrush.Call(uintptr(c))
	return brush
}

func highContrast() bool {
	var hc struct {
		Size   uint32
		Flags  uint32
		Scheme *uint16
	}
	hc.Size = uint32(unsafe.Sizeof(hc))
	r, _, _ := procSystemParametersInfo.Call(spiGetHighContrast, uintptr(hc.Size), uintptr(unsafe.Pointer(&hc)), 0)
	return r != 0 && hc.Flags&hcfHighContrastOn != 0
}

// appsUseDarkTheme reads the "Choose your mode" setting for apps.
func appsUseDarkTheme() bool {
	key, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer key.Close()
	light, _, err := key.GetIntegerValue("AppsUseLightTheme")
	return err == nil && light == 0
}

// styleWindow gives the title bar the dark colors when the theme is dark.
func (t *uiTheme) styleWindow(hwnd uintptr) {
	if t.plain || !t.dark {
		return
	}
	on := uint32(1)
	_, _, _ = procDwmSetWindowAttribute.Call(hwnd, dwmUseImmersiveDarkMode, uintptr(unsafe.Pointer(&on)), unsafe.Sizeof(on))
}

// styleControl asks Windows for its dark buttons and text boxes.
func (t *uiTheme) styleControl(hwnd uintptr, class string) {
	if t.plain || !t.dark {
		return
	}
	name := "DarkMode_Explorer"
	if class == "EDIT" {
		name = "DarkMode_CFD"
	}
	ptr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return
	}
	_, _, _ = procSetWindowTheme.Call(hwnd, uintptr(unsafe.Pointer(ptr)), 0)
}

// erase paints the window behind its controls: the card, the header and
// footer bands, and the lines between.
func (t *uiTheme) erase(hwnd, hdc uintptr) {
	var rc winRect
	_, _, _ = procGetClientRect.Call(hwnd, uintptr(unsafe.Pointer(&rc)))
	fill := func(r winRect, brush uintptr) {
		_, _, _ = procFillRect.Call(hdc, uintptr(unsafe.Pointer(&r)), brush)
	}
	headerBottom := int32(px(headerHeight))
	footerTop := rc.Bottom - int32(px(footerHeight))
	fill(rc, t.cardBrush)
	fill(winRect{0, 0, rc.Right, headerBottom}, t.bandBrush)
	fill(winRect{0, footerTop, rc.Right, rc.Bottom}, t.bandBrush)
	fill(winRect{0, headerBottom, rc.Right, headerBottom + 1}, t.borderBrush)
	fill(winRect{0, footerTop - 1, rc.Right, footerTop}, t.borderBrush)
	margin, divider := int32(px(contentMargin)), int32(px(dividerY))
	fill(winRect{margin, divider, rc.Right - margin, divider + 1}, t.borderBrush)
}

// behind is the brush for the part of the window a control sits on.
func (t *uiTheme) behind(control uintptr) uintptr {
	if onBand[control] {
		return t.bandBrush
	}
	return t.cardBrush
}

// colorLabel sets a label's colors and returns its background.
func (t *uiTheme) colorLabel(hdc, control uintptr) uintptr {
	color := t.text
	switch labelRole[control] {
	case roleMuted:
		color = t.muted
	case roleStatus:
		color = statusColor
	}
	_, _, _ = procSetBkMode.Call(hdc, bkTransparent)
	_, _, _ = procSetTextColor.Call(hdc, uintptr(color))
	return t.behind(control)
}

// colorEdit sets a text box's colors and returns its background.
func (t *uiTheme) colorEdit(hdc uintptr) uintptr {
	_, _, _ = procSetTextColor.Call(hdc, uintptr(t.text))
	_, _, _ = procSetBkColor.Call(hdc, uintptr(t.input))
	return t.inputBrush
}

// drawPrimary paints the main button: filled with the accent color, as in
// the apps.
func (t *uiTheme) drawPrimary(d *drawItem) {
	_, _, _ = procFillRect.Call(d.HDC, uintptr(unsafe.Pointer(&d.Rect)), t.behind(d.HwndItem))
	fill := t.accent
	switch {
	case d.ItemState&odsDisabled != 0:
		fill = t.border
	case d.ItemState&odsSelected != 0:
		fill = t.accentDown
	}
	brush := solidBrush(fill)
	pen, _, _ := procGetStockObject.Call(nullPen)
	oldBrush, _, _ := procSelectObject.Call(d.HDC, brush)
	oldPen, _, _ := procSelectObject.Call(d.HDC, pen)
	radius := uintptr(px(10))
	// With no pen the shape stops a pixel short on the right and bottom.
	_, _, _ = procRoundRect.Call(d.HDC, uintptr(d.Rect.Left), uintptr(d.Rect.Top), uintptr(d.Rect.Right+1), uintptr(d.Rect.Bottom+1), radius, radius)
	_, _, _ = procSelectObject.Call(d.HDC, oldBrush)
	_, _, _ = procSelectObject.Call(d.HDC, oldPen)
	_, _, _ = procDeleteObject.Call(brush)

	if font, _, _ := procSendMessage.Call(d.HwndItem, wmGetFont, 0, 0); font != 0 {
		_, _, _ = procSelectObject.Call(d.HDC, font)
	}
	_, _, _ = procSetBkMode.Call(d.HDC, bkTransparent)
	_, _, _ = procSetTextColor.Call(d.HDC, uintptr(t.onAccent))
	if text, err := windows.UTF16FromString(windowText(d.HwndItem)); err == nil {
		rc := d.Rect
		_, _, _ = procDrawText.Call(d.HDC, uintptr(unsafe.Pointer(&text[0])), ^uintptr(0), uintptr(unsafe.Pointer(&rc)), dtCenterVCenter1L)
	}
	if d.ItemState&odsFocus != 0 && d.ItemState&odsNoFocusRect == 0 {
		inset := int32(px(3))
		rc := winRect{d.Rect.Left + inset, d.Rect.Top + inset, d.Rect.Right - inset, d.Rect.Bottom - inset}
		_, _, _ = procDrawFocusRect.Call(d.HDC, uintptr(unsafe.Pointer(&rc)))
	}
}

// outerSize is the window size whose inside is w by h.
func outerSize(w, h int, style uintptr) (int, int) {
	rc := winRect{0, 0, int32(w), int32(h)}
	if r, _, _ := procAdjustWindowRectEx.Call(uintptr(unsafe.Pointer(&rc)), style, 0, 0); r == 0 {
		return w, h
	}
	return int(rc.Right - rc.Left), int(rc.Bottom - rc.Top)
}

// scaledFont is base at factor times its size, in the given weight.
func scaledFont(base logFont, factor float64, weight int32) uintptr {
	base.Height = int32(float64(base.Height) * factor)
	base.Weight = weight
	font, _, _ := procCreateFontIndirect.Call(uintptr(unsafe.Pointer(&base)))
	return font
}
