package hostcore

// Key is the Windows key a VNC keysym stands for.
type Key struct {
	// VK is the Windows virtual-key code.
	VK uint16
	// Extended marks the keys Windows tells apart from their keypad twins
	// by a flag: without it an arrow is the keypad's arrow, which Num Lock
	// and Shift treat differently.
	Extended bool
}

// Windows virtual-key codes KeyForKeysym hands out.
const (
	vkBack     = 0x08
	vkTab      = 0x09
	vkReturn   = 0x0D
	vkShift    = 0x10
	vkControl  = 0x11
	vkMenu     = 0x12
	vkPause    = 0x13
	vkCapital  = 0x14
	vkEscape   = 0x1B
	vkPrior    = 0x21
	vkNext     = 0x22
	vkEnd      = 0x23
	vkHome     = 0x24
	vkLeft     = 0x25
	vkUp       = 0x26
	vkRight    = 0x27
	vkDown     = 0x28
	vkSnapshot = 0x2C
	vkInsert   = 0x2D
	vkDelete   = 0x2E
	vkLWin     = 0x5B
	vkRWin     = 0x5C
	vkApps     = 0x5D
	vkF1       = 0x70
	vkNumLock  = 0x90
	vkScroll   = 0x91
	vkRShift   = 0xA1
	vkRControl = 0xA3
	vkRMenu    = 0xA5
)

// KeyForKeysym maps the keysyms that name a key rather than a character:
// editing and navigation keys, modifiers and function keys. Characters,
// letters and digits included, go through RuneForKeysym, because which
// key types one depends on the PC's keyboard layout.
func KeyForKeysym(keysym uint32) (Key, bool) {
	switch keysym {
	case 0xff08:
		return Key{VK: vkBack}, true
	case 0xff09, 0xfe20: // Tab, and the Shift+Tab some viewers name apart
		return Key{VK: vkTab}, true
	case 0xff0d:
		return Key{VK: vkReturn}, true
	case 0xff8d: // keypad Enter
		return Key{VK: vkReturn, Extended: true}, true
	case 0xff13:
		return Key{VK: vkPause}, true
	case 0xff14:
		return Key{VK: vkScroll}, true
	case 0xff1b:
		return Key{VK: vkEscape}, true
	case 0xff50, 0xff95:
		return Key{VK: vkHome, Extended: true}, true
	case 0xff51, 0xff96:
		return Key{VK: vkLeft, Extended: true}, true
	case 0xff52, 0xff97:
		return Key{VK: vkUp, Extended: true}, true
	case 0xff53, 0xff98:
		return Key{VK: vkRight, Extended: true}, true
	case 0xff54, 0xff99:
		return Key{VK: vkDown, Extended: true}, true
	case 0xff55, 0xff9a:
		return Key{VK: vkPrior, Extended: true}, true
	case 0xff56, 0xff9b:
		return Key{VK: vkNext, Extended: true}, true
	case 0xff57, 0xff9c:
		return Key{VK: vkEnd, Extended: true}, true
	case 0xff61:
		return Key{VK: vkSnapshot, Extended: true}, true
	case 0xff63, 0xff9e:
		return Key{VK: vkInsert, Extended: true}, true
	case 0xffff, 0xff9f:
		return Key{VK: vkDelete, Extended: true}, true
	case 0xff67:
		return Key{VK: vkApps, Extended: true}, true
	case 0xff7f:
		return Key{VK: vkNumLock, Extended: true}, true
	case 0xffe5:
		return Key{VK: vkCapital}, true
	case 0xffe1:
		return Key{VK: vkShift}, true
	case 0xffe2:
		return Key{VK: vkRShift}, true
	case 0xffe3:
		return Key{VK: vkControl}, true
	case 0xffe4:
		return Key{VK: vkRControl, Extended: true}, true
	case 0xffe9, 0xffe7: // Alt, and Meta, which keyboards without Alt send
		return Key{VK: vkMenu}, true
	case 0xffea, 0xffe8:
		return Key{VK: vkRMenu, Extended: true}, true
	case 0xffeb:
		return Key{VK: vkLWin, Extended: true}, true
	case 0xffec:
		return Key{VK: vkRWin, Extended: true}, true
	}
	if keysym >= 0xffbe && keysym <= 0xffc9 { // F1 to F12
		return Key{VK: uint16(vkF1 + keysym - 0xffbe)}, true
	}
	return Key{}, false
}

// Modifier bits for KeyModifier.
const (
	ModShift = 1 << iota
	ModControl
	ModAlt
	ModWin
)

// KeyModifier returns the modifier bit a virtual key holds down, 0 for any
// other key.
func KeyModifier(vk uint16) uint8 {
	switch vk {
	case vkShift, vkRShift:
		return ModShift
	case vkControl, vkRControl:
		return ModControl
	case vkMenu, vkRMenu:
		return ModAlt
	case vkLWin, vkRWin:
		return ModWin
	}
	return 0
}

// keypadRunes are the keypad keys that type a character. They are sent as
// that character, so they type it whatever Num Lock is set to on the PC.
var keypadRunes = map[uint32]rune{
	0xff80: ' ', 0xffaa: '*', 0xffab: '+', 0xffac: ',', 0xffad: '-',
	0xffae: '.', 0xffaf: '/', 0xffbd: '=',
}

// RuneForKeysym returns the character a keysym types. Keysyms that name a
// key instead (see KeyForKeysym) and ones that only shift what later keys
// type, such as AltGr, have none.
func RuneForKeysym(keysym uint32) (rune, bool) {
	switch {
	case keysym >= 0x20 && keysym <= 0x7e, keysym >= 0xa0 && keysym <= 0xff:
		return rune(keysym), true // Latin-1 keysyms are their code points
	case keysym >= 0xffb0 && keysym <= 0xffb9:
		return rune('0' + keysym - 0xffb0), true // keypad digits
	case keysym >= 0x01000100 && keysym <= 0x0110ffff:
		r := rune(keysym - 0x01000000)
		if r >= 0xd800 && r <= 0xdfff {
			return 0, false
		}
		return r, true
	}
	if r, ok := keypadRunes[keysym]; ok {
		return r, true
	}
	r, ok := legacyKeysyms[keysym]
	return r, ok
}
