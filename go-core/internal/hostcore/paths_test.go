package hostcore

import (
	"path/filepath"
	"testing"
)

func TestValidatePassword(t *testing.T) {
	if err := ValidatePassword(""); err == nil {
		t.Fatal("empty password was accepted")
	}
	if err := ValidatePassword("   "); err == nil {
		t.Fatal("blank password was accepted")
	}
	if err := ValidatePassword("123456789"); err == nil {
		t.Fatal("9-character password was accepted")
	}
	if err := ValidatePassword("secret"); err != nil {
		t.Fatal(err)
	}
}

func TestPaths(t *testing.T) {
	if got, want := DataDir(""), filepath.Join(`C:\ProgramData`, "NomadVNC Host"); got != want {
		t.Fatalf("DataDir = %q", got)
	}
	dir := DataDir(`D:\Data`)
	if got, want := PasswordPath(dir), filepath.Join(dir, "vnc-password.bin"); got != want {
		t.Fatalf("PasswordPath = %q", got)
	}
}
