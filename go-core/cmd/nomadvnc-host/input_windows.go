package main

import "unsafe"

var procSendInput = user32.NewProc("SendInput")

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
	keyEventKeyUp       = 0x0002
	keyEventUnicode     = 0x0004
	wheelDelta          = 120
)

// kbdInput matches INPUT with a KEYBDINPUT union on amd64 (40 bytes).
type kbdInput struct {
	Type  uint32
	_     uint32
	Vk    uint16
	Scan  uint16
	Flags uint32
	Time  uint32
	_     uint32
	Extra uintptr
}

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

func sendInputs(inputs []kbdInput) {
	if len(inputs) == 0 {
		return
	}
	_, _, _ = procSendInput.Call(
		uintptr(len(inputs)),
		uintptr(unsafe.Pointer(&inputs[0])),
		unsafe.Sizeof(inputs[0]),
	)
}

func sendMouse(input mouseInput) {
	_, _, _ = procSendInput.Call(1, uintptr(unsafe.Pointer(&input)), unsafe.Sizeof(input))
}

var heldButtons byte

func injectPointer(x, y int, buttons byte, width, height int) {
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

func injectKey(keysym uint32, down bool) {
	if vk, ok := keysymToVK(keysym); ok {
		flags := uint32(0)
		if !down {
			flags = keyEventKeyUp
		}
		sendInputs([]kbdInput{{
			Type:  inputKeyboard,
			Vk:    vk,
			Flags: flags,
		}})
		return
	}
	if !down || keysym > 0xFFFF {
		return
	}
	sendInputs([]kbdInput{{
		Type:  inputKeyboard,
		Scan:  uint16(keysym),
		Flags: keyEventUnicode,
	}})
}

func keysymToVK(keysym uint32) (uint16, bool) {
	switch keysym {
	case 0xff08:
		return 0x08, true // backspace
	case 0xff09:
		return 0x09, true // tab
	case 0xff0d:
		return 0x0d, true // return
	case 0xff1b:
		return 0x1b, true // escape
	case 0xff50:
		return 0x24, true // home
	case 0xff51:
		return 0x25, true // left
	case 0xff52:
		return 0x26, true // up
	case 0xff53:
		return 0x27, true // right
	case 0xff54:
		return 0x28, true // down
	case 0xff55:
		return 0x21, true // page up
	case 0xff56:
		return 0x22, true // page down
	case 0xff57:
		return 0x23, true // end
	case 0xffff:
		return 0x2e, true // delete
	case 0xffe1, 0xffe2:
		return 0x10, true // shift
	case 0xffe3, 0xffe4:
		return 0x11, true // control
	case 0xffe9, 0xffea:
		return 0x12, true // alt
	case 0xffeb, 0xffec:
		return 0x5b, true // windows
	case 0x20:
		return 0x20, true
	}
	if keysym >= 0xffbe && keysym <= 0xffc9 {
		return uint16(0x70 + (keysym - 0xffbe)), true
	}
	if keysym >= 'a' && keysym <= 'z' {
		return uint16(keysym - 'a' + 'A'), true
	}
	if keysym >= 'A' && keysym <= 'Z' {
		return uint16(keysym), true
	}
	if keysym >= '0' && keysym <= '9' {
		return uint16(keysym), true
	}
	return 0, false
}
