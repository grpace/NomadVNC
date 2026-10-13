package main

import (
	"unicode/utf16"
	"unsafe"

	"github.com/nomadvnc/nomadvnc/go-core/internal/hostcore"
)

var (
	procSendInput                = user32.NewProc("SendInput")
	procVkKeyScanEx              = user32.NewProc("VkKeyScanExW")
	procMapVirtualKeyEx          = user32.NewProc("MapVirtualKeyExW")
	procGetKeyboardLayout        = user32.NewProc("GetKeyboardLayout")
	procGetForegroundWindow      = user32.NewProc("GetForegroundWindow")
	procGetWindowThreadProcessId = user32.NewProc("GetWindowThreadProcessId")
)

const (
	inputMouse          = 0
	inputKeyboard       = 1
	mouseEventMove      = 0x0001
	mouseEventLeftDown  = 0x0002
	mouseEventLeftUp    = 0x0004
	mouseEventRightDown = 0x0008
	mouseEventRightUp   = 0x0010
	mouseEventMidDown   = 0x0020
	mouseEventMidUp     = 0x0040
	mouseEventWheel     = 0x0800
	mouseEventAbsolute  = 0x8000
	keyEventExtended    = 0x0001
	keyEventKeyUp       = 0x0002
	keyEventUnicode     = 0x0004
	wheelDelta          = 120
	mapVKToScan         = 0
	mapVKToChar         = 2
	// deadKey is set in what MapVirtualKeyEx returns for a key that waits
	// for the next key instead of typing.
	deadKey = 0x80000000
)

// kbdInput matches INPUT with a KEYBDINPUT union on amd64 and arm64. The
// union is as large as its largest member, MOUSEINPUT, so the keyboard
// fields are followed by padding.
type kbdInput struct {
	Type  uint32
	_     uint32
	Vk    uint16
	Scan  uint16
	Flags uint32
	Time  uint32
	_     uint32
	Extra uintptr
	_     [8]byte
}

// SendInput refuses a call whose size is not INPUT's 40 bytes, and takes
// nothing from it. These stop the build if either struct drifts.
var (
	_ [40]byte = [unsafe.Sizeof(kbdInput{})]byte{}
	_ [40]byte = [unsafe.Sizeof(mouseInput{})]byte{}
)

// mouseInput matches INPUT with a MOUSEINPUT union on amd64 (40 bytes).
type mouseInput struct {
	Type  uint32
	_     uint32
	Dx    int32
	Dy    int32
	Data  uint32
	Flags uint32
	Time  uint32
	_     uint32
	Extra uintptr
}

// inputDesk is the thread viewer input is sent from. Every viewer's input
// goes through it, in order.
var inputDesk *deskThread

func startInputWorker() {
	if inputDesk == nil {
		inputDesk = newDeskThread(false, nil)
	}
}

// sendInput hands events to Windows and reports whether it took them.
func sendInput(count int, first unsafe.Pointer, size uintptr) bool {
	r, _, _ := procSendInput.Call(uintptr(count), uintptr(first), size)
	return r != 0
}

// sendFromInputThread sends viewer input. Windows refuses input from a
// thread that isn't on the desktop it is showing, so a refusal usually
// means the screen just locked or an approval prompt came up: move there
// and send again.
func sendFromInputThread(count int, first unsafe.Pointer, size uintptr) {
	if !sendInput(count, first, size) && inputDesk.follow(true) {
		sendInput(count, first, size)
	}
}

func sendInputs(inputs []kbdInput) {
	if len(inputs) == 0 {
		return
	}
	sendFromInputThread(len(inputs), unsafe.Pointer(&inputs[0]), unsafe.Sizeof(inputs[0]))
}

func sendMouse(input mouseInput) {
	sendFromInputThread(1, unsafe.Pointer(&input), unsafe.Sizeof(input))
}

// heldButtons is used only on the input thread.
var heldButtons byte

func injectPointer(x, y int, buttons byte, width, height int) {
	inputDesk.do(func() { movePointer(x, y, buttons, width, height) })
}

func injectKey(keysym uint32, down bool) {
	inputDesk.do(func() { pressKey(keysym, down) })
}

// releaseInput lets go of every key and mouse button the viewers hold. A
// viewer that drops off mid-press or mid-drag would otherwise leave Shift
// down, or the PC dragging, for whoever uses it next.
func releaseInput() {
	inputDesk.do(func() {
		releaseAllKeys()
		transition(0, heldButtons, 0x01, mouseEventLeftDown, mouseEventLeftUp)
		transition(0, heldButtons, 0x02, mouseEventMidDown, mouseEventMidUp)
		transition(0, heldButtons, 0x04, mouseEventRightDown, mouseEventRightUp)
		heldButtons = 0
	})
}

func movePointer(x, y int, buttons byte, width, height int) {
	if width < 2 {
		width = 2
	}
	if height < 2 {
		height = 2
	}
	if x < 0 {
		x = 0
	}
	if y < 0 {
		y = 0
	}
	if x >= width {
		x = width - 1
	}
	if y >= height {
		y = height - 1
	}
	move := mouseInput{
		Type:  inputMouse,
		Dx:    int32(x * 65535 / (width - 1)),
		Dy:    int32(y * 65535 / (height - 1)),
		Flags: mouseEventMove | mouseEventAbsolute,
	}
	sendMouse(move)

	transition(buttons, heldButtons, 0x01, mouseEventLeftDown, mouseEventLeftUp)
	transition(buttons, heldButtons, 0x02, mouseEventMidDown, mouseEventMidUp)
	transition(buttons, heldButtons, 0x04, mouseEventRightDown, mouseEventRightUp)
	if buttons&0x08 != 0 {
		sendMouse(mouseInput{Type: inputMouse, Data: wheelDelta, Flags: mouseEventWheel})
	}
	if buttons&0x10 != 0 {
		delta := int32(-wheelDelta)
		sendMouse(mouseInput{Type: inputMouse, Data: uint32(delta), Flags: mouseEventWheel})
	}
	heldButtons = buttons & 0x07
}

func transition(next, prev, bit byte, down, up uint32) {
	was := prev&bit != 0
	now := next&bit != 0
	if was == now {
		return
	}
	flags := down
	if was {
		flags = up
	}
	sendMouse(mouseInput{Type: inputMouse, Flags: flags})
}

// sentKey is how a held keysym went down, so its release matches even if
// the layout or the modifiers changed in between.
type sentKey struct {
	vk       uint16
	extended bool
	layout   uintptr
}

// Keyboard state, used only on the input thread.
var (
	// downKeys holds the keys the viewers have down.
	downKeys = map[uint32]sentKey{}
	// heldMods is the modifiers among them (hostcore.ModShift and so on).
	heldMods uint8
)

func pressKey(keysym uint32, down bool) {
	if !down {
		releaseKey(keysym)
		return
	}
	if key, ok := hostcore.KeyForKeysym(keysym); ok {
		holdKey(keysym, sentKey{vk: key.VK, extended: key.Extended})
		return
	}
	r, ok := hostcore.RuneForKeysym(keysym)
	if !ok {
		return
	}
	if vk, layout, ok := layoutKey(r); ok {
		holdKey(keysym, sentKey{vk: vk, layout: layout})
		return
	}
	typeRune(r)
}

func holdKey(keysym uint32, key sentKey) {
	downKeys[keysym] = key
	heldMods |= hostcore.KeyModifier(key.vk)
	sendVK(key, true)
}

func releaseKey(keysym uint32) {
	key, held := downKeys[keysym]
	if !held {
		// A character typed whole needs no release. A key does, even one
		// that went down before this session started watching.
		k, ok := hostcore.KeyForKeysym(keysym)
		if !ok {
			return
		}
		key = sentKey{vk: k.VK, extended: k.Extended}
	}
	delete(downKeys, keysym)
	heldMods = 0
	for _, other := range downKeys {
		heldMods |= hostcore.KeyModifier(other.vk)
	}
	sendVK(key, false)
}

func releaseAllKeys() {
	for keysym := range downKeys {
		releaseKey(keysym)
	}
}

// layoutKey finds the key that types r on the keyboard layout of the
// window in front, so the PC gets a real key press: shortcuts work, and
// so do programs that read keys rather than text. It reports false when
// the character should be typed as text instead: the layout has no key
// for it, the key is a dead key, or it needs Shift or AltGr in a way the
// viewer isn't holding (its Caps Lock, or its own layout, produced the
// character).
func layoutKey(r rune) (vk uint16, layout uintptr, ok bool) {
	if r > 0xffff {
		return 0, 0, false
	}
	layout = foregroundLayout()
	found, _, _ := procVkKeyScanEx.Call(uintptr(r), layout)
	if int16(found) == -1 {
		return 0, 0, false
	}
	vk = uint16(found) & 0xff
	needs := uint8(uint16(found) >> 8) // 1 Shift, 2 Ctrl, 4 Alt
	if char, _, _ := procMapVirtualKeyEx.Call(uintptr(vk), mapVKToChar, layout); char&deadKey != 0 {
		return 0, 0, false
	}
	if heldMods&(hostcore.ModControl|hostcore.ModAlt|hostcore.ModWin) != 0 {
		// A shortcut: the key matters, not the character.
		return vk, layout, true
	}
	needsShift := needs&1 != 0
	if needs&^1 != 0 || needsShift != (heldMods&hostcore.ModShift != 0) {
		return 0, 0, false
	}
	return vk, layout, true
}

// foregroundLayout is the keyboard layout of the window in front, which
// can differ per window, or this thread's own when there is none.
func foregroundLayout() uintptr {
	var thread uintptr
	if hwnd, _, _ := procGetForegroundWindow.Call(); hwnd != 0 {
		thread, _, _ = procGetWindowThreadProcessId.Call(hwnd, 0)
	}
	layout, _, _ := procGetKeyboardLayout.Call(thread)
	if layout == 0 {
		layout, _, _ = procGetKeyboardLayout.Call(0)
	}
	return layout
}

func sendVK(key sentKey, down bool) {
	layout := key.layout
	if layout == 0 {
		layout, _, _ = procGetKeyboardLayout.Call(0)
	}
	scan, _, _ := procMapVirtualKeyEx.Call(uintptr(key.vk), mapVKToScan, layout)
	var flags uint32
	if key.extended {
		flags |= keyEventExtended
	}
	if !down {
		flags |= keyEventKeyUp
	}
	sendInputs([]kbdInput{{Type: inputKeyboard, Vk: key.vk, Scan: uint16(scan), Flags: flags}})
}

// typeRune types a character as text, whatever the PC's layout.
func typeRune(r rune) {
	var inputs []kbdInput
	for _, unit := range utf16.Encode([]rune{r}) {
		inputs = append(inputs,
			kbdInput{Type: inputKeyboard, Scan: unit, Flags: keyEventUnicode},
			kbdInput{Type: inputKeyboard, Scan: unit, Flags: keyEventUnicode | keyEventKeyUp},
		)
	}
	sendInputs(inputs)
}
