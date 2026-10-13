package hostcore

import "testing"

func TestKeyForKeysym(t *testing.T) {
	cases := []struct {
		keysym uint32
		want   Key
	}{
		{0xff0d, Key{VK: 0x0D}},
		{0xff8d, Key{VK: 0x0D, Extended: true}},
		{0xff51, Key{VK: 0x25, Extended: true}},
		{0xff63, Key{VK: 0x2D, Extended: true}},
		{0xffe1, Key{VK: 0x10}},
		{0xffe4, Key{VK: 0xA3, Extended: true}},
		{0xffe7, Key{VK: 0x12}},
		{0xffeb, Key{VK: 0x5B, Extended: true}},
		{0xffbe, Key{VK: 0x70}},
		{0xffc9, Key{VK: 0x7B}},
	}
	for _, c := range cases {
		got, ok := KeyForKeysym(c.keysym)
		if !ok || got != c.want {
			t.Errorf("KeyForKeysym(%#x) = %+v, %v; want %+v", c.keysym, got, ok, c.want)
		}
	}
	// Characters are not keys: the layout decides which key types them.
	// AltGr only changes what the viewer's own keyboard types.
	for _, keysym := range []uint32{'a', 'A', '1', ' ', '-', 0xfe03, 0xff7e, 0} {
		if key, ok := KeyForKeysym(keysym); ok {
			t.Errorf("KeyForKeysym(%#x) = %+v, want none", keysym, key)
		}
	}
}

func TestKeyModifier(t *testing.T) {
	for vk, want := range map[uint16]uint8{
		0x10: ModShift, 0xA1: ModShift, 0x11: ModControl, 0xA3: ModControl,
		0x12: ModAlt, 0xA5: ModAlt, 0x5B: ModWin, 0x5C: ModWin, 0x41: 0, 0x0D: 0,
	} {
		if got := KeyModifier(vk); got != want {
			t.Errorf("KeyModifier(%#x) = %d, want %d", vk, got, want)
		}
	}
}

func TestRuneForKeysym(t *testing.T) {
	cases := map[uint32]rune{
		'a':        'a',
		'~':        '~',
		0xe9:       'é',
		0x20ac:     '€', // legacy EuroSign
		0x06c1:     'а', // legacy Cyrillic_a, not U+06C1
		0x01b3:     'ł', // legacy lstroke
		0x010020ac: '€',
		0x0101f600: 0x1f600, // beyond the BMP
		0xffb5:     '5',     // keypad 5
		0xffab:     '+',
	}
	for keysym, want := range cases {
		got, ok := RuneForKeysym(keysym)
		if !ok || got != want {
			t.Errorf("RuneForKeysym(%#x) = %q, %v; want %q", keysym, got, ok, want)
		}
	}
	for _, keysym := range []uint32{0xff0d, 0xffe1, 0xfe03, 0x0100d800, 0x7f, 0x1f, 0} {
		if r, ok := RuneForKeysym(keysym); ok {
			t.Errorf("RuneForKeysym(%#x) = %q, want none", keysym, r)
		}
	}
}

func TestLegacyKeysymsCoverNoLatin1(t *testing.T) {
	// Latin-1 and the key keysyms are handled before the table; an entry
	// for one would never be read.
	for keysym := range legacyKeysyms {
		if keysym <= 0xff || keysym >= 0xfd00 {
			t.Errorf("legacy table holds %#x", keysym)
		}
	}
}
