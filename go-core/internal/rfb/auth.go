package rfb

import "crypto/des"

// VNCAuthResponse is the 16-byte reply to a VNC authentication challenge.
// The password is truncated or padded to 8 bytes, each byte is bit-reversed,
// and that key encrypts the challenge with DES in ECB mode (RFC 6143).
func VNCAuthResponse(challenge [16]byte, password string) [16]byte {
	var key [8]byte
	copy(key[:], password)
	for i := range key {
		key[i] = reverseBits(key[i])
	}

	block, err := des.NewCipher(key[:])
	if err != nil {
		return [16]byte{}
	}

	var out [16]byte
	block.Encrypt(out[0:8], challenge[0:8])
	block.Encrypt(out[8:16], challenge[8:16])
	return out
}

func reverseBits(b byte) byte {
	var out byte
	for i := 0; i < 8; i++ {
		out = (out << 1) | (b & 1)
		b >>= 1
	}
	return out
}
