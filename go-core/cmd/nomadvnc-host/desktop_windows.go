package main

import (
	"runtime"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	procOpenInputDesktop = user32.NewProc("OpenInputDesktop")
	procSetThreadDesktop = user32.NewProc("SetThreadDesktop")
	procCloseDesktop     = user32.NewProc("CloseDesktop")
)

const (
	genericAll = 0x10000000
	// deskCheckInterval is how often a thread looks for a desktop switch
	// when nothing has told it one happened.
	deskCheckInterval = 250 * time.Millisecond
)

// deskThread runs work on one OS thread that stays on the desktop Windows
// is showing. Windows keeps the signed-in desktop apart from the one that
// holds the lock screen, the sign-in screen and approval prompts, and a
// thread can capture and send input only on the desktop it is on.
type deskThread struct {
	work chan func()
	// desk is the desktop this thread moved to, 0 while it is still on
	// the one the process started on.
	desk    uintptr
	name    string
	checked time.Time
	// leave runs on the thread before it moves, to drop whatever belongs
	// to the desktop it is leaving.
	leave func()
	// report logs each move.
	report bool
}

func newDeskThread(report bool, leave func()) *deskThread {
	t := &deskThread{work: make(chan func()), leave: leave, report: report}
	go func() {
		runtime.LockOSThread()
		for fn := range t.work {
			t.follow(false)
			fn()
		}
	}()
	return t
}

// do runs fn on the thread and waits for it.
func (t *deskThread) do(fn func()) {
	done := make(chan struct{})
	t.work <- func() {
		defer close(done)
		fn()
	}
	<-done
}

// follow moves the thread to the desktop Windows is showing and reports
// whether it moved. Call it only on the thread. It looks at most every
// deskCheckInterval unless now is set.
func (t *deskThread) follow(now bool) bool {
	if !now && time.Since(t.checked) < deskCheckInterval {
		return false
	}
	t.checked = time.Now()
	desk, _, _ := procOpenInputDesktop.Call(0, 0, genericAll)
	if desk == 0 {
		// Mid-switch, or this process may not open the desktop in front:
		// only the service's own account can open the lock screen.
		return false
	}
	name := desktopName(desk)
	if name == t.name {
		procCloseDesktop.Call(desk)
		return false
	}
	if t.leave != nil {
		t.leave()
	}
	if r, _, err := procSetThreadDesktop.Call(desk); r == 0 {
		if t.report {
			logf("follow the screen to desktop %s: %v", name, err)
		}
		procCloseDesktop.Call(desk)
		return false
	}
	if t.desk != 0 {
		procCloseDesktop.Call(t.desk)
	}
	if t.report {
		logf("showing desktop %s", name)
	}
	t.desk, t.name = desk, name
	return true
}

func desktopName(desk uintptr) string {
	buf := make([]uint16, 64)
	var needed uint32
	r, _, _ := procGetUserObjectInformation.Call(
		desk,
		2, // UOI_NAME
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(len(buf)*2),
		uintptr(unsafe.Pointer(&needed)),
	)
	if r == 0 {
		return "unknown"
	}
	return windows.UTF16ToString(buf)
}
