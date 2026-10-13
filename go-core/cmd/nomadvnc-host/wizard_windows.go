package main

import (
	"context"
	"fmt"
	"os"
	"runtime"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/nomadvnc/nomadvnc/go-core/internal/hostcore"
	"github.com/nomadvnc/nomadvnc/go-core/internal/hostnet"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
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
	idPort         = 107
	idOK           = 1
	idCancel       = 2
	defaultGUIFont = 17
	mbYesNo        = 0x00000004
	mbIconQuestion = 0x00000020
	mbIconInfo     = 0x00000040
	idYes          = 6
	// colorBtnFace is the gray of dialog boxes, which labels are drawn on.
	colorBtnFace = 15
	// appIconID is the icon tools/hostres puts in the exe.
	appIconID = 1
	// spiGetNonClientMetrics asks for the fonts Windows itself uses.
	spiGetNonClientMetrics = 0x0029
)

// logFont is LOGFONTW.
type logFont struct {
	Height, Width, Escapement, Orientation, Weight int32
	Italic, Underline, StrikeOut, CharSet          byte
	OutPrecision, ClipPrecision, Quality, Pitch    byte
	FaceName                                       [32]uint16
}

// nonClientMetrics is NONCLIENTMETRICSW.
type nonClientMetrics struct {
	Size                                   uint32
	BorderWidth, ScrollWidth, ScrollHeight int32
	CaptionWidth, CaptionHeight            int32
	CaptionFont                            logFont
	SmCaptionWidth, SmCaptionHeight        int32
	SmCaptionFont                          logFont
	MenuWidth, MenuHeight                  int32
	MenuFont, StatusFont, MessageFont      logFont
	PaddedBorderWidth                      int32
}

// SystemParametersInfo fills the struct only if its size is the one
// Windows expects, 504 bytes. This stops the build if it drifts.
var _ [504]byte = [unsafe.Sizeof(nonClientMetrics{})]byte{}

// uiDPI is the screen's dots per inch; the layout below is written for 96.
var uiDPI = 96

// px scales a length from the 96 DPI layout to the screen.
func px(v int) int {
	return v * uiDPI / 96
}

// uiFont is the font Windows uses for its own dialogs (Segoe UI at the
// screen's scale), or the old fixed-size one if that can't be read.
func uiFont() uintptr {
	var metrics nonClientMetrics
	metrics.Size = uint32(unsafe.Sizeof(metrics))
	if r, _, _ := procSystemParametersInfo.Call(spiGetNonClientMetrics, uintptr(metrics.Size), uintptr(unsafe.Pointer(&metrics)), 0); r != 0 {
		if font, _, _ := procCreateFontIndirect.Call(uintptr(unsafe.Pointer(&metrics.MessageFont))); font != 0 {
			return font
		}
	}
	font, _, _ := procGetStockObject.Call(defaultGUIFont)
	return font
}

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

	procLoadIcon             = user32.NewProc("LoadIconW")
	procSetFocus             = user32.NewProc("SetFocus")
	procGetDpiForSystem      = user32.NewProc("GetDpiForSystem")
	procSystemParametersInfo = user32.NewProc("SystemParametersInfoW")
	procCreateFontIndirect   = gdi32.NewProc("CreateFontIndirectW")

	wizardStatusText atomic.Value
	wizardStatusHWND uintptr
	wizardName       uintptr
	wizardPassword   uintptr
	wizardConfirm    uintptr
	wizardPort       uintptr
	wizardMain       uintptr
	wizardDot        uintptr // the colored dot in the header
	wizardState      uintptr // what the host is doing, beside it
	wizardInstall    uintptr
	wizardUninstall  uintptr
	wizardTailnet    uintptr
	wizardTicks      int
	wizardHost       hostState
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

// hostState is what the installed host is doing.
type hostState int

const (
	hostAbsent hostState = iota
	hostStopped
	hostRunning
)

func queryHostState() hostState {
	manager, err := mgr.Connect()
	if err != nil {
		return hostAbsent
	}
	defer manager.Disconnect()
	service, err := manager.OpenService(hostcore.ServiceName)
	if err != nil {
		return hostAbsent
	}
	defer service.Close()
	status, err := service.Query()
	if err != nil || status.State != svc.Running {
		return hostStopped
	}
	return hostRunning
}

func runWizard() {
	// Windows hands a window's messages only to the thread that made it.
	// Unpinned, Go moves this loop to another thread once the program gets
	// busy, as Tailscale sign-in makes it, and the window stops answering.
	runtime.LockOSThread()
	enableDPIAware()
	setStatus("")

	module, _, err := procGetModuleHandleW.Call(0)
	if module == 0 {
		logf("wizard: %v", err)
		return
	}
	instance := windows.Handle(module)
	theme = loadTheme()
	// GetDpiForSystem is missing before Windows 10 1607; 96 then.
	if procGetDpiForSystem.Find() == nil {
		if dpi, _, _ := procGetDpiForSystem.Call(); dpi >= 96 {
			uiDPI = int(dpi)
		}
	}

	className, _ := windows.UTF16PtrFromString("NomadVNCHostSetup")
	cursor, _, _ := procLoadCursor.Call(0, 32512)
	icon, _, _ := procLoadIcon.Call(module, appIconID)
	class := wndClassEx{
		WndProc:    wizardProc,
		Instance:   instance,
		Icon:       icon,
		IconSm:     icon,
		Cursor:     cursor,
		Background: windows.Handle(colorBtnFace + 1),
		Class:      className,
	}
	class.Size = uint32(unsafe.Sizeof(class))
	if atom, _, err := procRegisterClassEx.Call(uintptr(unsafe.Pointer(&class))); atom == 0 {
		logf("wizard window class: %v", err)
		return
	}

	title, _ := windows.UTF16PtrFromString("NomadVNC Host")
	const style = wsOverlapped | wsCaption | wsSysMenu | wsMinimizeBox
	width, height := outerSize(px(wizardWidth), px(wizardHeight), style)
	screenW, _, _ := procGetSystemMetrics.Call(0)
	screenH, _, _ := procGetSystemMetrics.Call(1)
	x, y := 80, 80
	if int(screenW) > width && int(screenH) > height {
		x = (int(screenW) - width) / 2
		y = (int(screenH) - height) / 2
	}
	// Shown once its controls are in place, so it appears whole.
	hwnd, _, err := procCreateWindowEx.Call(
		0,
		uintptr(unsafe.Pointer(className)),
		uintptr(unsafe.Pointer(title)),
		style,
		uintptr(x), uintptr(y), uintptr(width), uintptr(height),
		0, 0, uintptr(instance), 0,
	)
	if hwnd == 0 {
		logf("wizard window: %v", err)
		return
	}
	wizardMain = hwnd
	theme.styleWindow(hwnd)
	buildWizard(hwnd, instance, module)
	refreshWizard()
	setWindowText(wizardStatusHWND, idleHint(wizardHost))
	_, _, _ = procSetTimer.Call(hwnd, 1, 300, 0)
	_, _, _ = procShowWindow.Call(hwnd, 1)
	_, _, _ = procSetForeground.Call(hwnd)
	// The name is filled in already; the password is what's left to type.
	_, _, _ = procSetFocus.Call(wizardPassword)

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

// buildWizard lays the controls out. Positions are in 96 DPI units.
func buildWizard(hwnd uintptr, instance windows.Handle, module uintptr) {
	var metrics nonClientMetrics
	metrics.Size = uint32(unsafe.Sizeof(metrics))
	font := uiFont()
	titleFont := font
	if r, _, _ := procSystemParametersInfo.Call(spiGetNonClientMetrics, uintptr(metrics.Size), uintptr(unsafe.Pointer(&metrics)), 0); r != 0 {
		titleFont = scaledFont(metrics.MessageFont, 1.6, 600)
	}
	const (
		left  = contentMargin
		wide  = wizardWidth - 2*contentMargin
		textX = left + 52 // header text, right of the logo
	)
	label := func(x, y, w, h int, text string, role textRole, band bool, extra uintptr) uintptr {
		control := makeControl(hwnd, instance, font, "STATIC", text, wsChild|wsVisible|extra, 0, x, y, w, h, 0)
		labelRole[control], onBand[control] = role, band
		return control
	}

	// Header: logo, name, and what the host is doing.
	if logo, _, _ := procLoadImage.Call(module, appIconID, imageIcon, uintptr(px(40)), uintptr(px(40)), 0); logo != 0 {
		holder := label(left, 24, 40, 40, "", roleText, true, ssIcon)
		_, _, _ = procSendMessage.Call(holder, stmSetIcon, logo, 0)
	}
	name := label(textX, 20, wide-52, 28, "NomadVNC Host", roleText, true, 0)
	_, _, _ = procSendMessage.Call(name, wmSetFont, titleFont, 1)
	wizardDot = label(textX, 51, 14, 18, "\u25CF", roleStatus, true, 0)
	wizardState = label(textX+16, 51, wide-68, 18, "", roleMuted, true, 0)

	// Settings.
	const portWidth, gap = 96, 12
	label(left, 104, wide-portWidth-gap, 18, "Name", roleText, false, 0)
	wizardName = makeEdit(hwnd, instance, font, left, 124, wide-portWidth-gap, 28, idName, false)
	setWindowText(wizardName, initialMachineName())
	setCue(wizardName, "This PC's Windows name")
	label(left+wide-portWidth, 104, portWidth, 18, "Port", roleText, false, 0)
	wizardPort = makeEdit(hwnd, instance, font, left+wide-portWidth, 124, portWidth, 28, idPort, false)
	setWindowText(wizardPort, fmt.Sprint(savedPort()))
	setCue(wizardPort, fmt.Sprint(hostcore.DefaultPort))
	label(left, 156, wide, 18, "Shown in the viewer. Also this PC's name on your tailnet.", roleMuted, false, 0)
	label(left, 186, wide, 18, "Password", roleText, false, 0)
	wizardPassword = makeEdit(hwnd, instance, font, left, 206, wide, 28, idPassword, true)
	setCue(wizardPassword, "Up to 8 characters")
	label(left, 246, wide, 18, "Confirm Password", roleText, false, 0)
	wizardConfirm = makeEdit(hwnd, instance, font, left, 266, wide, 28, idConfirm, true)
	label(left, 300, wide, 18, "Viewers connect to the port above with this password.", roleMuted, false, 0)

	primaryStyle := uintptr(bsOwnerDraw)
	if theme.plain {
		primaryStyle = bsDefPush
	}
	wizardInstall = makeControl(hwnd, instance, font, "BUTTON", "Install and Start", wsChild|wsVisible|wsTabStop|primaryStyle, 0, left, 332, wide, 36, idInstall)
	wizardStatusHWND = label(left, 378, wide, 56, "", roleMuted, false, 0)

	// Reaching this PC from another network.
	wizardTailnet = label(left, 458, wide, 36, "", roleMuted, false, 0)
	makeButton(hwnd, instance, font, left, 502, 200, 30, idTailscale, "Sign In with Tailscale")

	// Footer.
	wizardUninstall = makeButton(hwnd, instance, font, left, wizardHeight-footerHeight+13, 110, 30, idUninstall, "Uninstall")
	onBand[wizardUninstall] = true
	label(wizardWidth-contentMargin-200, wizardHeight-footerHeight+19, 200, 18, "Version "+version, roleMuted, true, ssRight)
}

// refreshWizard brings the header, the labels and the buttons in line with
// what the host is doing. Text is set only when it changes, so nothing
// flickers.
func refreshWizard() {
	state := queryHostState()
	wizardHost = state
	color, text := theme.muted, "Not set up on this PC yet"
	switch state {
	case hostRunning:
		color, text = theme.good, fmt.Sprintf("Sharing this screen as %s, on port %d", deviceHostname(), savedPort())
	case hostStopped:
		color, text = theme.warn, "Installed, but not running"
	}
	if color != statusColor {
		statusColor = color
		_, _, _ = procInvalidateRect.Call(wizardDot, 0, 1)
	}
	setTextIfChanged(wizardState, text)

	action := "Install and Start"
	if state != hostAbsent {
		action = "Save and Restart"
	}
	setTextIfChanged(wizardInstall, action)
	enabled := uintptr(0)
	if state != hostAbsent {
		enabled = 1
	}
	_, _, _ = procEnableWindow.Call(wizardUninstall, enabled)

	tailnet := "Tailscale is optional. Any VPN that can reach this PC works, and the local network needs none."
	if hostnet.HasIdentity(hostcore.TailscaleDir(dataDir())) {
		tailnet = "Signed in to Tailscale. This PC is on your tailnet as " + deviceHostname() + "."
	}
	setTextIfChanged(wizardTailnet, tailnet)
}

// idleHint is what the message area says when nothing has happened yet:
// what to do next, for the state the host is in.
func idleHint(state hostState) string {
	switch state {
	case hostRunning:
		return "To change the name, the port or the password, enter them and choose Save and Restart."
	case hostStopped:
		return "To start the host, enter its password and choose Save and Restart."
	}
	return "Choose a name and a password, then Install and Start. From then on this PC shares its screen whenever it is on, with no window."
}

func setTextIfChanged(hwnd uintptr, text string) {
	if hwnd != 0 && windowText(hwnd) != text {
		setWindowText(hwnd, text)
	}
}

// setCue puts a hint in an empty text box.
func setCue(edit uintptr, text string) {
	if ptr, err := windows.UTF16PtrFromString(text); err == nil {
		_, _, _ = procSendMessage.Call(edit, emSetCueBanner, 0, uintptr(unsafe.Pointer(ptr)))
	}
}

func wizardWndProc(hwnd, msg, wparam, lparam uintptr) uintptr {
	switch msg {
	case wmCommand:
		if wparam>>16 == bnClicked {
			switch wparam & 0xFFFF {
			case idInstall, idOK: // Enter in a text box is the main button
				onInstall()
			case idTailscale:
				onTailscale()
			case idUninstall:
				onUninstall()
			case idCancel: // Esc
				_, _, _ = procDestroyWindow.Call(hwnd)
			}
			refreshWizard()
		}
	case wmTimer:
		message := statusLine()
		if message == "" {
			message = idleHint(wizardHost)
		}
		setTextIfChanged(wizardStatusHWND, message)
		// The service is asked about every fifth tick, 1.5 seconds.
		if wizardTicks++; wizardTicks%5 == 0 {
			refreshWizard()
		}
	case wmEraseBkgnd:
		if !theme.plain {
			theme.erase(hwnd, wparam)
			return 1
		}
	case wmCtlColorStatic:
		if !theme.plain {
			return theme.colorLabel(wparam, lparam)
		}
	case wmCtlColorBtn:
		if !theme.plain {
			return theme.behind(lparam)
		}
	case wmCtlColorEdit:
		if !theme.plain && theme.dark {
			return theme.colorEdit(wparam)
		}
	case wmDrawItem:
		if item := drawItemFrom(lparam); item != nil && item.CtlID == idInstall && !theme.plain {
			theme.drawPrimary(item)
			return 1
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
	return desktopName(desktop)
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
	port, err := hostcore.ParsePort(windowText(wizardPort))
	if err != nil {
		setStatus(err.Error())
		return
	}
	setStatus("Installing…")
	if err := installHost(password, port, true); err != nil {
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
		// The service owns the node; sign-in borrows the saved identity
		// only until Tailscale approves it, then the service resumes.
		stopService()
		loginCtx, loginCancel := context.WithTimeout(context.Background(), 5*time.Minute)
		watchCtx, watchCancel := context.WithCancel(context.Background())
		armTailscaleWait(func() {
			loginCancel()
			watchCancel()
		})
		defer stopTailscaleWait()
		dir := hostcore.TailscaleDir(dataDir())
		expiry, err := hostnet.SignIn(loginCtx, dir, deviceHostname(), openURL, setStatus)
		if startErr := startService(); startErr != nil {
			logf("start after tailscale: %v", startErr)
		}
		if err != nil {
			setStatus("Tailscale sign-in did not finish. " + err.Error())
			logf("tailscale sign-in: %v", err)
			return
		}
		hostnet.WaitForKeyExpiryOff(watchCtx, dir, expiry, openURL, setStatus)
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

// tell shows a message and waits for OK.
func tell(title, text string) {
	titlePtr, err := windows.UTF16PtrFromString(title)
	if err != nil {
		return
	}
	textPtr, err := windows.UTF16PtrFromString(text)
	if err != nil {
		return
	}
	_, _ = windows.MessageBox(windows.HWND(wizardMain), textPtr, titlePtr, mbIconInfo)
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
		uintptr(px(x)), uintptr(px(y)), uintptr(px(w)), uintptr(px(h)),
		parent,
		uintptr(id),
		uintptr(instance),
		0,
	)
	if hwnd != 0 && font != 0 {
		_, _, _ = procSendMessage.Call(hwnd, wmSetFont, font, 1)
	}
	if hwnd != 0 {
		theme.styleControl(hwnd, class)
	}
	return hwnd
}
