package engine

import (
	"context"
	"testing"

	"github.com/nomadvnc/nomadvnc/go-core/internal/config"
)

func TestSetTailscaleHostnameDoesNotStartTheNode(t *testing.T) {
	cfg := config.Default()
	cfg.DefaultHostname = "NomadVNC-iphone"
	cfg.Hostname = cfg.DefaultHostname
	eng := New(cfg)

	got, err := eng.SetTailscaleHostname(context.Background(), "Greg iPhone")
	if err != nil {
		t.Fatal(err)
	}
	if got.Hostname != "greg-iphone" || got.Applied {
		t.Fatalf("result = %+v", got)
	}
	if eng.server != nil {
		t.Fatal("setting the name started the tailnet node")
	}

	cleared, err := eng.SetTailscaleHostname(context.Background(), "  ")
	if err != nil {
		t.Fatal(err)
	}
	if cleared.Hostname != "NomadVNC-iphone" || cleared.Applied {
		t.Fatalf("cleared = %+v", cleared)
	}

	if _, err := eng.SetTailscaleHostname(context.Background(), "!!!"); err == nil {
		t.Fatal("expected a rejection")
	}
}
