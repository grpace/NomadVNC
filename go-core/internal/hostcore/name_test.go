package hostcore

import "testing"

func TestNormalizeMachineName(t *testing.T) {
	name, err := NormalizeMachineName("  Bay 1 ")
	if err != nil {
		t.Fatal(err)
	}
	if name != "bay-1" {
		t.Fatalf("name = %q", name)
	}

	name, err = NormalizeMachineName("")
	if err != nil || name != "" {
		t.Fatalf("empty name = %q, %v", name, err)
	}

	if _, err := NormalizeMachineName("!!!"); err == nil {
		t.Fatal("punctuation-only name was accepted")
	}

	long := "abcdefghijklmnopqrstuvwxyz-0123456789-extra"
	name, err = NormalizeMachineName(long)
	if err != nil {
		t.Fatal(err)
	}
	if len(name) > 32 || stringsHasHyphenEnd(name) {
		t.Fatalf("trimmed name = %q", name)
	}
}

func stringsHasHyphenEnd(name string) bool {
	return len(name) > 0 && (name[0] == '-' || name[len(name)-1] == '-')
}
