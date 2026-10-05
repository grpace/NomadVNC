package rfb

import "testing"

func TestReverseBits(t *testing.T) {
	if got := reverseBits(0x01); got != 0x80 {
		t.Fatalf("reverseBits(0x01) = %#x, want 0x80", got)
	}
	if got := reverseBits(0x80); got != 0x01 {
		t.Fatalf("reverseBits(0x80) = %#x, want 0x01", got)
	}
}

func TestVNCAuthResponseDeterministic(t *testing.T) {
	var challenge [16]byte
	for i := range challenge {
		challenge[i] = byte(i + 1)
	}

	first := VNCAuthResponse(challenge, "secret")
	second := VNCAuthResponse(challenge, "secret")
	if first != second {
		t.Fatal("same password and challenge produced different responses")
	}
	other := VNCAuthResponse(challenge, "Secret")
	if other == first {
		t.Fatal("different passwords produced the same response")
	}
}
