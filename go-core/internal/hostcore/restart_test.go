package hostcore

import (
	"testing"
	"time"
)

func TestRestartDelay(t *testing.T) {
	cases := map[int]time.Duration{
		0:   0,
		1:   0,
		2:   2 * time.Second,
		3:   4 * time.Second,
		6:   32 * time.Second,
		7:   time.Minute,
		500: time.Minute,
	}
	for exits, want := range cases {
		if got := RestartDelay(exits); got != want {
			t.Errorf("RestartDelay(%d) = %v, want %v", exits, got, want)
		}
	}
}
