package config

import "testing"

func TestNormalizeChosenHostname(t *testing.T) {
	name, err := NormalizeChosenHostname("  Greg.Tech iOS ")
	if err != nil {
		t.Fatal(err)
	}
	if name != "greg-tech-ios" {
		t.Fatalf("name = %q", name)
	}
	if got, err := NormalizeChosenHostname("greg-iphone"); err != nil || got != "greg-iphone" {
		t.Fatalf("got %q err %v", got, err)
	}
	if got, err := NormalizeChosenHostname("   "); err != nil || got != "" {
		t.Fatalf("blank got %q err %v", got, err)
	}
	if _, err := NormalizeChosenHostname("!!!"); err == nil {
		t.Fatal("expected an error for a name with no letters")
	}
}

func TestAutomaticHostnameSkipsLocalhost(t *testing.T) {
	if got := AutomaticHostname("localhost"); got == "NomadVNC-localhost" {
		t.Fatalf("automatic name used localhost: %q", got)
	}
	if got := AutomaticHostname("Greg.Tech iOS"); got != "NomadVNC-greg-tech-ios" {
		t.Fatalf("automatic name = %q", got)
	}
}

func TestDefaultTailscaleHostnameShape(t *testing.T) {
	name := DefaultTailscaleHostname()
	if name == "NomadVNC-localhost" {
		t.Fatalf("default name used localhost: %q", name)
	}
	if len(name) < len("NomadVNC-") || len(name) > 63 {
		t.Fatalf("name %q", name)
	}
}
