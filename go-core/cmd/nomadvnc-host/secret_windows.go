package main

import (
	"fmt"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	crypt32                = windows.NewLazySystemDLL("crypt32.dll")
	procCryptProtectData   = crypt32.NewProc("CryptProtectData")
	procCryptUnprotectData = crypt32.NewProc("CryptUnprotectData")
	procLocalFree          = windows.NewLazySystemDLL("kernel32.dll").NewProc("LocalFree")
)

// dataBlob matches DATA_BLOB. The pointer is 8-byte aligned on amd64.
type dataBlob struct {
	Size uint32
	_    uint32
	Data *byte
}

const cryptProtectLocalMachine = 0x4

func protectSecret(plain []byte) ([]byte, error) {
	if len(plain) == 0 {
		return nil, fmt.Errorf("empty secret")
	}
	in := dataBlob{Size: uint32(len(plain)), Data: &plain[0]}
	var out dataBlob
	r, _, err := procCryptProtectData.Call(
		uintptr(unsafe.Pointer(&in)),
		0, 0, 0, 0,
		cryptProtectLocalMachine,
		uintptr(unsafe.Pointer(&out)),
	)
	if r == 0 {
		if err != nil && err != windows.ERROR_SUCCESS {
			return nil, err
		}
		return nil, fmt.Errorf("CryptProtectData failed")
	}
	defer procLocalFree.Call(uintptr(unsafe.Pointer(out.Data)))
	raw := unsafe.Slice(out.Data, out.Size)
	return append([]byte(nil), raw...), nil
}

func unprotectSecret(wrapped []byte) ([]byte, error) {
	if len(wrapped) == 0 {
		return nil, fmt.Errorf("empty secret")
	}
	in := dataBlob{Size: uint32(len(wrapped)), Data: &wrapped[0]}
	var out dataBlob
	r, _, err := procCryptUnprotectData.Call(
		uintptr(unsafe.Pointer(&in)),
		0, 0, 0, 0,
		0,
		uintptr(unsafe.Pointer(&out)),
	)
	if r == 0 {
		if err != nil && err != windows.ERROR_SUCCESS {
			return nil, err
		}
		return nil, fmt.Errorf("CryptUnprotectData failed")
	}
	defer procLocalFree.Call(uintptr(unsafe.Pointer(out.Data)))
	raw := unsafe.Slice(out.Data, out.Size)
	return append([]byte(nil), raw...), nil
}

func writePassword(password string) error {
	if err := os.MkdirAll(dataDir(), 0o755); err != nil {
		return err
	}
	wrapped, err := protectSecret([]byte(password))
	if err != nil {
		return err
	}
	return os.WriteFile(passwordPath(), wrapped, 0o644)
}

func readPassword() (string, error) {
	wrapped, err := os.ReadFile(passwordPath())
	if err != nil {
		return "", err
	}
	plain, err := unprotectSecret(wrapped)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func passwordPath() string {
	return dataDir() + `\vnc-password.bin`
}
