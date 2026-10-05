package main

import (
	"context"
	"fmt"
	"os"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/nomadvnc/nomadvnc/go-core/internal/hostcore"
	"github.com/nomadvnc/nomadvnc/go-core/internal/hostnet"
	"golang.org/x/sys/windows"
)

const (
	wsOverlapped   = 0x00000000
	wsCaption      = 0x00C00000
	wsSysMenu      = 0x00080000
	wsMinimizeBox  = 0x00020000
	wsVisible      = 0x10000000
	wsChild        = 0x40000000
	wsTabStop      = 0x00010000
	wsExClientEdge = 0x00000200
	esPassword     = 0x0020
	esAutoHScroll  = 0x0080
	wmDestroy      = 0x0002
	wmClose        = 0x0010
	wmCommand      = 0x0111
	wmTimer        = 0x0113
	wmSetFont      = 0x0030
	bnClicked      = 0
	idName         = 100
	idPassword     = 101
	idConfirm      = 102
	idInstall      = 103
	idTailscale    = 104
	idUninstall    = 105
	idStatus       = 106
	defaultGUIFont = 17
	mbYesNo        = 0x00000004
	mbIconQuestion = 0x00000020
	idYes          = 6
)

var (
	procRegisterClassEx  = user32.NewProc("RegisterClassExW")
	procCreateWindowEx   = user32.NewProc("CreateWindowExW")
	procDefWindowProc    = user32.NewProc("DefWindowProcW")
	procGetMessage       = user32.NewProc("GetMessageW")
	procTranslate        = user32.NewProc("TranslateMessage")
	procDispatch         = user32.NewProc("DispatchMessageW")
	procPostQuit         = user32.NewProc("PostQuitMessage")
	procGetWindowText    = user32.NewProc("GetWindowTextW")
	procSetWindowText    = user32.NewProc("SetWindowTextW")
	procSendMessage      = user32.NewProc("SendMessageW")
	procSetTimer         = user32.NewProc("SetTimer")
	procLoadCursor       = user32.NewProc("LoadCursorW")
	procGetStockObject   = gdi32.NewProc("GetStockObject")
	procIsDialogMessage  = user32.NewProc("IsDialogMessageW")
	procShowWindow       = user32.NewProc("ShowWindow")
	procSetForeground    = user32.NewProc("SetForegroundWindow")
	procGetModuleHandleW = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetModuleHandleW")

	wizardStatusText atomic.Value
	wizardStatusHWND uintptr
	wizardName       uintptr
	wizardPassword   uintptr
	wizardConfirm    uintptr
	wizardMain       uintptr
	signInBusy       atomic.Bool
)

type wndClassEx struct {
	Size       uint32
	Style      uint32
	WndProc    uintptr
	ClsExtra   int32
	WndExtra   int32
	Instance   windows.Handle
	Icon       uintptr
	Cursor     uintptr
	Background windows.Handle
	Menu       *uint16
	Class      *uint16
	IconSm     uintptr
}

type winMsg struct {
	Hwnd    uintptr
	Message uint32
	_       uint32
	WParam  uintptr
	LParam  uintptr
	Time    uint32
	PtX     int32
	PtY     int32
	Private uint32
}

var wizardProc = windows.NewCallback(wizardWndProc)

func runWizard() {
	enableDPIAware()
	setStatus("Enter a VNC password. This PC will share its screen and start at boot.")

	module, _, err := procGetModuleHandleW.Call(0)
	if module == 0 {
		logf("wizard: %v", err)
		return
	}
	instance := windows.Handle(module)
	className, _ := windows.UTF16PtrFromString("NomadVNCHostSetup")
	cursor, _, _ := procLoadCursor.Call(0, 32512)
	class := wndClassEx{
		WndProc:    wizardProc,
		Instance:   instance,
		Cursor:     cursor,
		Background: windows.Handle(6), // COLOR_WINDOW + 1
		Class:      className,
	}
	class.Size = uint32(unsafe.Sizeof(class))
	if atom, _, err := procRegisterClassEx.Call(uintptr(unsafe.Pointer(&class))); atom == 0 {
		logf("wizard window class: %v", err)
		return
	}

	title, _ := windows.UTF16PtrFromString("NomadVNC Host")
	width, height := 480, 500
	screenW, _, _ := procGetSystemMetrics.Call(0)
	screenH, _, _ := procGetSystemMetrics.Call(1)
	x, y := 80, 80
	if int(screenW) > width && int(screenH) > height {
		x = (int(screenW) - width) / 2
		y = (int(screenH) - height) / 2
	}
	hwnd, _, err := procCreateWindowEx.Call(
		0,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(title)),
		wsOverlapped|wsCaption|wsSysMenu|wsMinimizeBox|wsVisible,
		uintptr(x), uintptr(y), uintptr(width), uintptr(height),
		0, 0, uintptr(instance), 0,
	)
	if hwnd == 0 {
		logf("wizard window: %v", err)
		return
	}
	_, _, _ = procShowWindow.Call(hwnd, 1)
	_, _, _ = procSetForeground.Call(hwnd)
	wizardMain = hwnd
	logf("wizard window hwnd=%x rect=%s desktop=%s", hwnd, windowRect(hwnd), currentDesktop())
	font, _, _ := procGetStockObject.Call(defaultGUIFont)

	makeStatic(hwnd, instance, font, 24, 16, 420, 36, "Share this PC's screen with NomadVNC. After setup it starts at boot, with no window.")
	makeStatic(hwnd, instance, font, 24, 58, 420, 18, "Name")
	wizardName = makeEdit(hwnd, instance, font, 24, 78, 420, 24, idName, false)
	setWindowText(wizardName, initialMachineName())
	makeStatic(hwnd, instance, font, 24, 112, 420, 18, "Password")
	wizardPassword = makeEdit(hwnd, instance, font, 24, 132, 420, 24, idPassword, true)
	makeStatic(hwnd, instance, font, 24, 166, 420, 18, "Confirm Password")
	wizardConfirm = makeEdit(hwnd, instance, font, 24, 186, 420, 24, idConfirm, true)
	makeButton(hwnd, instance, font, 24, 226, 200, 28, idInstall, "Install and Start")
	makeButton(hwnd, instance, font, 234, 226, 210, 28, idTailscale, "Sign In with Tailscale")
	makeButton(hwnd, instance, font, 24, 264, 120, 28, idUninstall, "Uninstall")
	makeStatic(hwnd, instance, font, 24, 304, 420, 32, "Tailscale is optional. Any VPN that can reach this PC works, and the local network needs none.")
	wizardStatusHWND = makeStatic(hwnd, instance, font, 24, 340, 420, 100, "")
	_, _, _ = procSetTimer.Call(hwnd, 1, 300, 0)
	setWindowText(wizardStatusHWND, statusLine())

	var msg winMsg
	for {
		ret, _, _ := procGetMessage.Call(uintptr(unsafe.Pointer(&msg)), 0, 0, 0)
		if int32(ret) <= 0 {
			return
		}
		if dialog, _, _ := procIsDialogMessage.Call(hwnd, uintptr(unsafe.Pointer(&msg))); dialog == 0 {
			_, _, _ = procTranslate.Call(uintptr(unsafe.Pointer(&msg)))
			_, _, _ = procDispatch.Call(uintptr(unsafe.Pointer(&msg)))
		}
	}
}

func wizardWndProc(hwnd, msg, wparam, lparam uintptr) uintptr {
	switch msg {
	case wmCommand:
		if wparam>>16 == bnClicked {
			switch wparam & 0xFFFF {
			case idInstall:
				onInstall()
			case idTailscale:
				onTailscale()
			case idUninstall:
				onUninstall()
			}
		}
	case wmTimer:
		if wizardStatusHWND != 0 {
			setWindowText(wizardStatusHWND, statusLine())
		}
	case wmClose:
		_, _, _ = procDestroyWindow.Call(hwnd)
	case wmDestroy:
		stopTailscaleWait()
		_, _, _ = procPostQuit.Call(0)
		return 0
	}
	ret, _, _ := procDefWindowProc.Call(hwnd, msg, wparam, lparam)
	return ret
}

var procDestroyWindow = user32.NewProc("DestroyWindow")
var procGetWindowRect = user32.NewProc("GetWindowRect")
var procGetThreadDesktop = user32.NewProc("GetThreadDesktop")
var procGetUserObjectInformation = user32.NewProc("GetUserObjectInformationW")

func windowRect(hwnd uintptr) string {
	var rect struct {
		Left, Top, Right, Bottom int32
	}
	if r, _, _ := procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&rect))); r == 0 {
		return "unavailable"
	}
	return fmt.Sprintf("%d,%d %dx%d", rect.Left, rect.Top, rect.Right-rect.Left, rect.Bottom-rect.Top)
}

func currentDesktop() string {
	desktop, _, _ := procGetThreadDesktop.Call(uintptr(windows.GetCurrentThreadId()))
	if desktop == 0 {
		return "none"
	}
	buf := make([]uint16, 64)
	var needed uint32
	r, _, _ := procGetUserObjectInformation.Call(
		desktop,
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

func initialMachineName() string {
	if name := savedMachineName(); name != "" {
		return name
	}
	host, err := os.Hostname()
	if err != nil {
		return ""
	}
	name, err := hostcore.NormalizeMachineName(host)
	if err != nil {
		return ""
	}
	return name
}

func onInstall() {
	if err := saveMachineName(windowText(wizardName)); err != nil {
		setStatus(err.Error())
		return
	}
	password := windowText(wizardPassword)
	confirm := windowText(wizardConfirm)
	if password != confirm {
		setStatus("Those passwords do not match.")
		return
	}
	if err := hostcore.ValidatePassword(password); err != nil {
		setStatus(err.Error())
		return
	}
	setStatus("Installing…")
	if err := installHost(password); err != nil {
		setStatus(err.Error())
		logf("install: %v", err)
		return
	}
	setStatus(deviceHostname() + " is running. It will start at boot. This network is set to Private so other computers on it can connect.")
}

var (
	tailscaleWaitMu     sync.Mutex
	tailscaleWaitCancel context.CancelFunc
)

func armTailscaleWait(cancel context.CancelFunc) {
	tailscaleWaitMu.Lock()
	if tailscaleWaitCancel != nil {
		tailscaleWaitCancel()
	}
	tailscaleWaitCancel = cancel
	tailscaleWaitMu.Unlock()
}

func stopTailscaleWait() {
	tailscaleWaitMu.Lock()
	cancel := tailscaleWaitCancel
	tailscaleWaitCancel = nil
	tailscaleWaitMu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func onTailscale() {
	if !signInBusy.CompareAndSwap(false, true) {
		return
	}
	setStatus("Waiting for Tailscale sign-in in the browser.")
	go func() {
		defer signInBusy.Store(false)
		if err := saveMachineName(windowText(wizardName)); err != nil {
			setStatus(err.Error())
			return
		}
		stopService()
		loginCtx, loginCancel := context.WithTimeout(context.Background(), 5*time.Minute)
		watchCtx, watchCancel := context.WithCancel(context.Background())
		armTailscaleWait(func() {
			loginCancel()
			watchCancel()
		})
		defer stopTailscaleWait()
		err := hostnet.SignIn(loginCtx, hostcore.TailscaleDir(dataDir()), deviceHostname(), openURL, setStatus, watchCtx)
		if err != nil {
			setStatus("Tailscale sign-in did not finish. " + err.Error())
			logf("tailscale sign-in: %v", err)
		}
		if err := startService(); err != nil {
			logf("start after tailscale: %v", err)
		}
	}()
}

func onUninstall() {
	if !ask("Uninstall NomadVNC Host", "Uninstall NomadVNC Host from this PC?") {
		return
	}
	deleteData := ask("Uninstall NomadVNC Host", "Also remove the saved VNC password and Tailscale sign-in?")
	if err := uninstallHost(deleteData); err != nil {
		setStatus(err.Error())
		return
	}
	if deleteData {
		setStatus("NomadVNC Host was removed, including its saved password.")
		return
	}
	setStatus("NomadVNC Host was removed. The saved password is still on this PC.")
}

func openURL(url string) {
	ptr, err := windows.UTF16PtrFromString(url)
	if err != nil {
		return
	}
	_ = windows.ShellExecute(0, nil, ptr, nil, nil, windows.SW_SHOWNORMAL)
}

func setStatus(text string) {
	wizardStatusText.Store(text)
}

func statusLine() string {
	if v := wizardStatusText.Load(); v != nil {
		if text, ok := v.(string); ok {
			return text
		}
	}
	return ""
}

func windowText(hwnd uintptr) string {
	buf := make([]uint16, 256)
	procGetWindowText.Call(hwnd, uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)))
	return windows.UTF16ToString(buf)
}

func ask(title, text string) bool {
	titlePtr, err := windows.UTF16PtrFromString(title)
	if err != nil {
		return false
	}
	textPtr, err := windows.UTF16PtrFromString(text)
	if err != nil {
		return false
	}
	answer, _ := windows.MessageBox(windows.HWND(wizardMain), textPtr, titlePtr, mbYesNo|mbIconQuestion)
	return answer == idYes
}

func setWindowText(hwnd uintptr, text string) {
	ptr, err := windows.UTF16PtrFromString(text)
	if err != nil {
		return
	}
	_, _, _ = procSetWindowText.Call(hwnd, uintptr(unsafe.Pointer(ptr)))
}

func makeStatic(parent uintptr, instance windows.Handle, font uintptr, x, y, w, h int, text string) uintptr {
	return makeControl(parent, instance, font, "STATIC", text, wsChild|wsVisible, 0, x, y, w, h, 0)
}

func makeEdit(parent uintptr, instance windows.Handle, font uintptr, x, y, w, h, id int, password bool) uintptr {
	style := uintptr(wsChild | wsVisible | wsTabStop | esAutoHScroll)
	if password {
		style |= esPassword
	}
	return makeControl(parent, instance, font, "EDIT", "", style, wsExClientEdge, x, y, w, h, id)
}

func makeButton(parent uintptr, instance windows.Handle, font uintptr, x, y, w, h, id int, text string) uintptr {
	return makeControl(parent, instance, font, "BUTTON", text, wsChild|wsVisible|wsTabStop, 0, x, y, w, h, id)
}

func makeControl(parent uintptr, instance windows.Handle, font uintptr, class, text string, style, ex uintptr, x, y, w, h, id int) uintptr {
	classPtr, _ := windows.UTF16PtrFromString(class)
	textPtr, _ := windows.UTF16PtrFromString(text)
	hwnd, _, _ := procCreateWindowEx.Call(
		ex,
		uintptr(unsafe.Pointer(classPtr)),
		uintptr(unsafe.Pointer(textPtr)),
		style,
		uintptr(x), uintptr(y), uintptr(w), uintptr(h),
		parent,
		uintptr(id),
		uintptr(instance),
		0,
	)
	if hwnd != 0 && font != 0 {
		_, _, _ = procSendMessage.Call(hwnd, wmSetFont, font, 1)
	}
	return hwnd
}
