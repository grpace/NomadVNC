package mobile

import (
	"encoding/json"
	"testing"

	"github.com/nomadvnc/nomadvnc/go-core/internal/session"
)

// PollEvents must never block, even with no events pending, and must
// return a valid JSON array the native module can parse unconditionally.
func TestPollEventsEmpty(t *testing.T) {
	raw := PollEvents()
	var events []json.RawMessage
	if err := json.Unmarshal([]byte(raw), &events); err != nil {
		t.Fatalf("PollEvents returned invalid JSON: %v (%q)", err, raw)
	}
	if len(events) != 0 {
		t.Fatalf("expected no events, got %d", len(events))
	}
}

func TestDrainEvents(t *testing.T) {
	ch := make(chan session.Event, 4)
	ch <- session.Event{Type: "connectionState", SessionID: "s1", State: "connected"}
	ch <- session.Event{Type: "error", Scope: "tailnet", Message: "boom"}

	drained := drainEvents(ch)
	if len(drained) != 2 {
		t.Fatalf("expected 2 drained events, got %d", len(drained))
	}
	var first session.Event
	if err := json.Unmarshal(drained[0], &first); err != nil {
		t.Fatalf("drained event is not valid JSON: %v", err)
	}
	if first.Type != "connectionState" || first.SessionID != "s1" {
		t.Fatalf("unexpected first event: %+v", first)
	}
	// Channel is empty now; a second drain returns nothing and does not block.
	if rest := drainEvents(ch); len(rest) != 0 {
		t.Fatalf("expected empty second drain, got %d", len(rest))
	}
}
