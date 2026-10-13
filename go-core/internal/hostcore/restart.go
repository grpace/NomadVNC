package hostcore

import "time"

const (
	// SessionSettled is how long a screen session must run before its exit
	// counts as a one-off rather than part of a run of failures.
	SessionSettled = 30 * time.Second
	// maxRestartDelay caps the wait between restarts.
	maxRestartDelay = time.Minute
)

// RestartDelay is how long to wait before starting the screen session
// again after quickExits exits in a row that each came before
// SessionSettled. The first is restarted at once, as after a crash. A
// session that keeps stopping straight away, because another program has
// its port for example, is retried less and less often.
func RestartDelay(quickExits int) time.Duration {
	if quickExits <= 1 {
		return 0
	}
	delay := 2 * time.Second << min(quickExits-2, 5)
	return min(delay, maxRestartDelay)
}
