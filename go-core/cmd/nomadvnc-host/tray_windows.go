package main

import (
	"fmt"
	"io"
	"os"
	"runtime"
	"unsafe"

	"github.com/nomadvnc/nomadvnc/go-core/internal/hostcore"
	"golang.org/x/sys/windows"
)

// The icon in the system tray. The service runs with no window, so this
// is the sign that the PC is being shared and the way back to the setup
// window. It runs as the signed-in person, started by the service, and
// holds no settings: it asks Windows whether the service is running.

var (
	shell32                   = windows.NewLazySystemDLL("shell32.dll")
	procShellNotifyIcon       = shell32.NewProc("Shell_NotifyIconW")
	procRegisterWindowMessage = user32.NewProc("RegisterWindowMessageW")
	procCreatePopupMenu       = user32.NewProc("CreatePopupMenu")
	procAppendMenu            = user32.NewProc("AppendMenuW")
	procTrackPopupMenu        = user32.NewProc("TrackPopupMenu")
	procDestroyMenu           = user32.NewProc("DestroyMenu")
	procGetCursorPos          = user32.NewProc("GetCursorPos")
	procPostMessage           = user32.NewProc("PostMessageW")
	procFindWindow            = user32.NewProc("FindWindowW")
	procSetMenuDefaultItem    = user32.NewProc("SetMenuDefaultItem")
	trayProc                  = windows.NewCallback(trayWndProc)
	trayIcon                  notifyIconData
	trayPort                  = hostcore.DefaultPort
	trayTaskbarCreated        uint32
	trayLastTip               string
)

const (
	wmApp           = 0x8000
	wmTrayIcon      = wmApp + 1
	wmLButtonUp     = 0x0202
	wmLButtonDblClk = 0x0203
	wmRButtonUp     = 0x0205
	wmContextMenu   = 0x007B
	nimAdd          = 0
	nimModify       = 1
	nimDelete       = 2
	nifMessage      = 0x1
	nifIcon         = 0x2
	nifTip          = 0x4
	tpmReturnCmd    = 0x0100
	tpmRightButton  = 0x0002
	trayOpen        = 1
	smCXSmallIcon   = 49
	idiApplication  = 32512
	trayIconID      = 2
)

// notifyIconData is NOTIFYICONDATAW on amd64 and arm64.
type notifyIconData struct {
	Size            uint32
	Hwnd            uintptr
	ID              uint32
	Flags           uint32
	CallbackMessage uint32
	Icon            uintptr
	Tip             [128]uint16
	State           uint32
	StateMask       uint32
	Info            [256]uint16
	Version         uint32
	InfoTitle       [64]uint16
	InfoFlags       uint32
	GUID            windows.GUID
	BalloonIcon     uintptr
}

// Shell_NotifyIcon ignores a struct of any other size.
var _ [976]byte = [unsafe.Sizeof(notifyIconData{})]byte{}

func runTray() {
	// The window's messages come only to the thread that made it.
	runtime.LockOSThread()
	if port, err := hostcore.ParsePort(flagValue("--port")); err == nil {
		trayPort = port
	}
	module, _, _ := procGetModuleHandleW.Call(0)
	if module == 0 {
		return
	}
	className, _ := windows.UTF16PtrFromString("NomadVNCHostTray")
	class := wndClassEx{WndProc: trayProc, Instance: windows.Handle(module), Class: className}
	class.Size = uint32(unsafe.Sizeof(class))
	if atom, _, _ := procRegisterClassEx.Call(uintptr(unsafe.Pointer(&class))); atom == 0 {
		return
	}
	// Never shown: it only receives the icon's clicks.
	hwnd, _, _ := procCreateWindowEx.Call(0, uintptr(unsafe.Pointer(className)), 0, 0, 0, 0, 0, 0, 0, 0, module, 0)
	if hwnd == 0 {
		return
	}
	// Explorer announces this when the taskbar is rebuilt, after a crash
	// or at sign-in; icons added before then are gone.
	if name, err := windows.UTF16PtrFromString("TaskbarCreated"); err == nil {
		msg, _, _ := procRegisterWindowMessage.Call(uintptr(unsafe.Pointer(name)))
		trayTaskbarCreated = uint32(msg)
	}

	size, _, _ := procGetSystemMetrics.Call(smCXSmallIcon)
	// The tray has its own icon (tools/hostres): the logo is too fine a
	// drawing to read this small.
	icon, _, _ := procLoadImage.Call(module, trayIconID, imageIcon, size, size, 0)
	if icon == 0 {
		icon, _, _ = procLoadIcon.Call(0, idiApplication)
	}
	trayIcon = notifyIconData{Hwnd: hwnd, ID: 1, Flags: nifMessage | nifIcon | nifTip, CallbackMessage: wmTrayIcon, Icon: icon}
	trayIcon.Size = uint32(unsafe.Sizeof(trayIcon))
	updateTray(nimAdd)
	_, _, _ = procSetTimer.Call(hwnd, 1, 5000, 0)

	// The service holds the other end of stdin and closes it to say leave.
	// Started by hand there is no such pipe, and the icon stays.
	if info, err := os.Stdin.Stat(); err == nil && info.Mode()&os.ModeNamedPipe != 0 {
		go func() {
			_, _ = io.Copy(io.Discard, os.Stdin)
			_, _, _ = procPostMessage.Call(hwnd, wmClose, 0, 0)
		}()
	}

	var msg winMsg
	for {
		ret, _, _ := procGetMessage.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
		if int32(ret) <= 0 {
			return
		}
		_, _, _ = procTranslate.Call(uintptr(unsafe.Pointer(&msg)))
		_, _, _ = procDispatch.Call(uintptr(unsafe.Pointer(&msg)))
	}
}

// updateTray adds the icon or refreshes its tip. It reports false when the
// host is no longer installed.
func updateTray(action uintptr) bool {
	running, installed := serviceRunning()
	tip := "NomadVNC Host is not running"
	if running {
		tip = fmt.Sprintf("NomadVNC Host is sharing this screen on port %d", trayPort)
	}
	if action == nimModify && tip == trayLastTip {
		return installed
	}
	trayLastTip = tip
	text, _ := windows.UTF16FromString(tip)
	trayIcon.Tip = [128]uint16{}
	copy(trayIcon.Tip[:len(trayIcon.Tip)-1], text)
	_, _, _ = procShellNotifyIcon.Call(action, uintptr(unsafe.Pointer(&trayIcon)))
	return installed
}

// serviceRunning asks Windows about the service with the rights an
// ordinary account has.
func serviceRunning() (running, installed bool) {
	manager, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return false, true
	}
	defer windows.CloseServiceHandle(manager)
	name, err := windows.UTF16PtrFromString(hostcore.ServiceName)
	if err != nil {
		return false, true
	}
	service, err := windows.OpenService(manager, name, windows.SERVICE_QUERY_STATUS)
	if err != nil {
		return false, err != windows.ERROR_SERVICE_DOES_NOT_EXIST
	}
	defer windows.CloseServiceHandle(service)
	var status windows.SERVICE_STATUS
	if err := windows.QueryServiceStatus(service, &status); err != nil {
		return false, true
	}
	return status.CurrentState == windows.SERVICE_RUNNING, true
}

func trayWndProc(hwnd, msg, wparam, lparam uintptr) uintptr {
	switch {
	case msg == wmTrayIcon:
		switch lparam & 0xFFFF {
		case wmLButtonUp, wmLButtonDblClk:
			openSetupWindow()
		case wmRButtonUp, wmContextMenu:
			trayMenu(hwnd)
		}
		return 0
	case msg == wmTimer:
		if !updateTray(nimModify) {
			// Uninstalled: nothing left to show.
			_, _, _ = procDestroyWindow.Call(hwnd)
		}
		return 0
	case trayTaskbarCreated != 0 && uint32(msg) == trayTaskbarCreated:
		updateTray(nimAdd)
		return 0
	case msg == wmClose:
		_, _, _ = procDestroyWindow.Call(hwnd)
		return 0
	case msg == wmDestroy:
		_, _, _ = procShellNotifyIcon.Call(nimDelete, uintptr(unsafe.Pointer(&trayIcon)))
		_, _, _ = procPostQuit.Call(0)
		return 0
	}
	ret, _, _ := procDefWindowProc.Call(hwnd, msg, wparam, lparam)
	return ret
}

func trayMenu(hwnd uintptr) {
	menu, _, _ := procCreatePopupMenu.Call()
	if menu == 0 {
		return
	}
	defer procDestroyMenu.Call(menu)
	if label, err := windows.UTF16PtrFromString("Open NomadVNC Host"); err == nil {
		_, _, _ = procAppendMenu.Call(menu, 0, trayOpen, uintptr(unsafe.Pointer(label)))
		_, _, _ = procSetMenuDefaultItem.Call(menu, trayOpen, 0)
	}
	var at struct{ X, Y int32 }
	_, _, _ = procGetCursorPos.Call(uintptr(unsafe.Pointer(&at)))
	// Without this the menu stays up when the person clicks elsewhere.
	_, _, _ = procSetForeground.Call(hwnd)
	if chosen, _, _ := procTrackPopupMenu.Call(menu, tpmReturnCmd|tpmRightButton, uintptr(at.X), uintptr(at.Y), 0, hwnd, 0); chosen == trayOpen {
		openSetupWindow()
	}
}

// openSetupWindow brings the setup window forward, or starts it. Starting
// it asks for administrator approval, as it does from the Start menu.
func openSetupWindow() {
	if class, err := windows.UTF16PtrFromString("NomadVNCHostSetup"); err == nil {
		if existing, _, _ := procFindWindow.Call(uintptr(unsafe.Pointer(class)), 0); existing != 0 {
			_, _, _ = procShowWindow.Call(existing, 9) // SW_RESTORE
			_, _, _ = procSetForeground.Call(existing)
			return
		}
	}
	exe, err := os.Executable()
	if err != nil {
		return
	}
	if ptr, err := windows.UTF16PtrFromString(exe); err == nil {
		_ = windows.ShellExecute(0, nil, ptr, nil, nil, windows.SW_SHOWNORMAL)
	}
}
