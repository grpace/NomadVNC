package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/nomadvnc/nomadvnc/go-core/internal/hostcore"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

func isElevated() bool {
	token := windows.GetCurrentProcessToken()
	return token.IsElevated()
}

// isPrivileged reports whether this process may install the service.
// LocalSystem can, even when the UAC elevation bit is unset on a token
// that was moved onto the signed-in desktop.
func isPrivileged() bool {
	if isElevated() {
		return true
	}
	token := windows.GetCurrentProcessToken()
	user, err := token.GetTokenUser()
	if err != nil {
		return false
	}
	system, err := windows.CreateWellKnownSid(windows.WinLocalSystemSid)
	if err != nil {
		return false
	}
	return windows.EqualSid(user.User.Sid, system)
}

func relaunchElevated() error {
	verb, err := windows.UTF16PtrFromString("runas")
	if err != nil {
		return err
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	exePtr, err := windows.UTF16PtrFromString(exe)
	if err != nil {
		return err
	}
	// Quoted again, or a name with a space in it would arrive in pieces.
	args := windows.ComposeCommandLine(os.Args[1:])
	var argPtr *uint16
	if args != "" {
		argPtr, err = windows.UTF16PtrFromString(args)
		if err != nil {
			return err
		}
	}
	return windows.ShellExecute(0, verb, exePtr, argPtr, nil, windows.SW_SHOWNORMAL)
}

// installHost installs or updates the host: the password viewers give,
// the port they connect to, and whether an icon sits in the system tray.
func installHost(password string, port int, tray bool) (err error) {
	if err := hostcore.ValidatePassword(password); err != nil {
		return err
	}
	if !isPrivileged() {
		return errors.New("administrator approval is required")
	}
	if err := lockDataDir(); err != nil {
		return fmt.Errorf("protect %s: %w", dataDir(), err)
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	dest := installedExe()
	stopService()
	// An upgrade that fails part way must not leave a PC that was
	// reachable switched off. Starting what is there is harmless when
	// nothing was installed before.
	defer func() {
		if err != nil {
			_ = startService()
		}
	}()
	if !sameFile(exe, dest) {
		if err := copyExecutable(exe, dest); err != nil {
			return err
		}
	}
	if err := writePassword(password); err != nil {
		return err
	}
	if err := savePort(port); err != nil {
		return err
	}
	if err := saveTrayWanted(tray); err != nil {
		return err
	}
	if err := preferPrivateNetwork(); err != nil {
		logf("network profile: %v", err)
	}
	if err := installFirewall(port); err != nil {
		return err
	}
	if err := installService(dest); err != nil {
		return err
	}
	if err := installShortcut(dest); err != nil {
		logf("start menu shortcut: %v", err)
	}
	if err := registerApp(dest); err != nil {
		logf("list under Installed apps: %v", err)
	}
	return startService()
}

// uninstallKey is where Windows keeps what it lists under Installed apps.
const uninstallKey = `SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\NomadVNCHost`

// registerApp lists the host under Installed apps in Windows Settings, so
// it can be found and removed there like any other program, and so tools
// that manage PCs can see which version each one has.
func registerApp(exe string) error {
	key, _, err := registry.CreateKey(registry.LOCAL_MACHINE, uninstallKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer key.Close()
	quoted := `"` + exe + `"`
	for name, value := range map[string]string{
		"DisplayName":     "NomadVNC Host",
		"DisplayVersion":  version,
		"Publisher":       "Greg Pace",
		"InstallLocation": filepath.Dir(exe),
		"DisplayIcon":     exe,
		"URLInfoAbout":    "https://greg.tech/nomadvnc/",
		"InstallDate":     time.Now().Format("20060102"),
		// Settings runs the first; tools that must not stop to ask run
		// the second, which keeps the saved password.
		"UninstallString":      quoted + " --uninstall --ask",
		"QuietUninstallString": quoted + " --uninstall",
	} {
		if err := key.SetStringValue(name, value); err != nil {
			return err
		}
	}
	numbers := map[string]uint32{"NoModify": 1, "NoRepair": 1}
	if info, err := os.Stat(exe); err == nil {
		numbers["EstimatedSize"] = uint32(info.Size() / 1024) // in KB
	}
	for name, value := range numbers {
		if err := key.SetDWordValue(name, value); err != nil {
			return err
		}
	}
	return nil
}

func uninstallHost(deleteData bool) error {
	if !isPrivileged() {
		return errors.New("administrator approval is required")
	}
	stopService()
	_ = exec.Command("sc.exe", "delete", hostcore.ServiceName).Run()
	_ = exec.Command("netsh", "advfirewall", "firewall", "delete", "rule", "name="+hostcore.FirewallRule).Run()
	_ = os.Remove(shortcutPath())
	_ = registry.DeleteKey(registry.LOCAL_MACHINE, uninstallKey)
	removeInstallDir()
	// Last, and nothing may write the log after it: logging would put the
	// folder back.
	if deleteData {
		_ = os.RemoveAll(dataDir())
	}
	return nil
}

// removeInstallDir deletes the program folder. The Start menu shortcut and
// Installed apps both run the copy inside it, and a running program can't
// be deleted. It can be moved, so it is moved out of the folder to the
// temporary folder, and Windows deletes it there at the next restart.
func removeInstallDir() {
	dir := hostcore.InstallDir(os.Getenv("ProgramFiles"))
	if running, err := os.Executable(); err == nil && sameFile(running, installedExe()) {
		aside := filepath.Join(os.TempDir(), fmt.Sprintf("nomadvnc-host-removed-%d.exe", os.Getpid()))
		if err := os.Rename(running, aside); err != nil {
			// The temporary folder is on another drive, say. Leave both
			// the exe and its folder for the restart to clear.
			logf("move the running program aside: %v", err)
			deleteAtRestart(running)
			deleteAtRestart(dir)
			return
		}
		deleteAtRestart(aside)
	}
	// Something may hold the folder for a moment: a virus scan of the exe
	// just moved, an older setup window still open.
	for attempt := 0; attempt < 10; attempt++ {
		if os.RemoveAll(dir) == nil {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	deleteAtRestart(dir)
}

// deleteAtRestart has Windows delete path the next time it starts.
func deleteAtRestart(path string) {
	ptr, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return
	}
	_ = windows.MoveFileEx(ptr, nil, windows.MOVEFILE_DELAY_UNTIL_REBOOT)
}

func sameFile(a, b string) bool {
	infoA, errA := os.Stat(a)
	infoB, errB := os.Stat(b)
	if errA != nil || errB != nil {
		return false
	}
	return os.SameFile(infoA, infoB)
}

func copyExecutable(src, dest string) error {
	if err := os.MkdirAll(hostcore.InstallDir(os.Getenv("ProgramFiles")), 0o755); err != nil {
		return err
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dest + ".new"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(out, in)
	closeErr := out.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	// The old program may still be running: its setup window, left open.
	// Windows won't delete or overwrite a running program, but will move
	// it, so it goes to the temporary folder for Windows to delete at the
	// next restart.
	if err := os.Remove(dest); err != nil && !os.IsNotExist(err) {
		aside := filepath.Join(os.TempDir(), fmt.Sprintf("nomadvnc-host-replaced-%d.exe", os.Getpid()))
		if err := os.Rename(dest, aside); err != nil {
			_ = os.Remove(tmp)
			return fmt.Errorf("replace %s (close any NomadVNC Host window and try again): %w", dest, err)
		}
		deleteAtRestart(aside)
	}
	if err := os.Rename(tmp, dest); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return nil
}

func preferPrivateNetwork() error {
	// A home PC is often left on the Public firewall profile, which would
	// hide the VNC port. Sharing the screen is a local-network action, so
	// setup moves connected Public profiles to Private.
	script := `Get-NetConnectionProfile | Where-Object NetworkCategory -eq 'Public' | ForEach-Object { Set-NetConnectionProfile -InterfaceIndex $_.InterfaceIndex -NetworkCategory Private }`
	out, err := exec.Command("powershell.exe", "-NoProfile", "-Command", script).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %s", err, bytesTrim(out))
	}
	return nil
}

func installFirewall(port int) error {
	_ = exec.Command("netsh", "advfirewall", "firewall", "delete", "rule", "name="+hostcore.FirewallRule).Run()
	out, err := exec.Command(
		"netsh", "advfirewall", "firewall", "add", "rule",
		"name="+hostcore.FirewallRule,
		"dir=in",
		"action=allow",
		"protocol=TCP",
		fmt.Sprintf("localport=%d", port),
		"profile=private,domain",
	).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %s", err, bytesTrim(out))
	}
	return nil
}

func installService(exe string) error {
	// Quoted, so Windows can't read the space in "Program Files" as the
	// end of the program name and start C:\Program.exe instead.
	exe = `"` + exe + `"`
	query := exec.Command("sc.exe", "query", hostcore.ServiceName)
	if err := query.Run(); err != nil {
		out, err := exec.Command(
			"sc.exe", "create", hostcore.ServiceName,
			"binPath=", exe,
			"start=", "auto",
			"DisplayName=", "NomadVNC Host",
		).CombinedOutput()
		if err != nil {
			return fmt.Errorf("%s: %s", err, bytesTrim(out))
		}
	} else {
		out, err := exec.Command(
			"sc.exe", "config", hostcore.ServiceName,
			"binPath=", exe,
			"start=", "auto",
			"DisplayName=", "NomadVNC Host",
		).CombinedOutput()
		if err != nil {
			return fmt.Errorf("%s: %s", err, bytesTrim(out))
		}
	}
	_ = exec.Command("sc.exe", "description", hostcore.ServiceName, "Shares this PC's screen with NomadVNC.").Run()
	_ = exec.Command("sc.exe", "failure", hostcore.ServiceName, "reset=", "86400", "actions=", "restart/5000/restart/5000/restart/5000").Run()
	// Also restart after the service stops itself with an error, not only
	// after a crash.
	_ = exec.Command("sc.exe", "failureflag", hostcore.ServiceName, "1").Run()
	return nil
}

func installShortcut(exe string) error {
	path := shortcutPath()
	script := fmt.Sprintf(`$s = (New-Object -ComObject WScript.Shell).CreateShortcut(%q); $s.TargetPath = %q; $s.WorkingDirectory = %q; $s.Description = 'NomadVNC Host setup'; $s.Save()`, path, exe, hostcore.InstallDir(os.Getenv("ProgramFiles")))
	out, err := exec.Command("powershell.exe", "-NoProfile", "-Command", script).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %s", err, bytesTrim(out))
	}
	return nil
}

func shortcutPath() string {
	return os.Getenv("ProgramData") + `\Microsoft\Windows\Start Menu\Programs\NomadVNC Host.lnk`
}

func startService() error {
	out, err := exec.Command("sc.exe", "start", hostcore.ServiceName).CombinedOutput()
	if err != nil && !strings.Contains(strings.ToUpper(string(out)), "RUNNING") && !strings.Contains(string(out), "1056") {
		return fmt.Errorf("%s: %s", err, bytesTrim(out))
	}
	return nil
}

func stopService() {
	_ = exec.Command("sc.exe", "stop", hostcore.ServiceName).Run()
	for i := 0; i < 25; i++ {
		out, err := exec.Command("sc.exe", "query", hostcore.ServiceName).CombinedOutput()
		text := string(out)
		if err != nil || strings.Contains(text, "STOPPED") || strings.Contains(text, "1060") {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func bytesTrim(b []byte) string {
	return strings.TrimSpace(string(b))
}

func passwordFromArgs(args []string) (string, error) {
	for i := 0; i < len(args); i++ {
		if args[i] == "--password" && i+1 < len(args) {
			return args[i+1], nil
		}
		if strings.HasPrefix(args[i], "--password=") {
			return strings.TrimPrefix(args[i], "--password="), nil
		}
	}
	stat, err := os.Stdin.Stat()
	if err != nil || stat.Mode()&os.ModeCharDevice != 0 {
		return "", errors.New("pass --password or pipe the password on stdin")
	}
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", err
	}
	line = strings.TrimSpace(line)
	if line == "" {
		return "", errors.New("pass --password or pipe the password on stdin")
	}
	return line, nil
}

func hasFlag(flag string) bool {
	for _, arg := range os.Args[1:] {
		if arg == flag {
			return true
		}
	}
	return false
}

func flagValue(flag string) string {
	for i, arg := range os.Args[1:] {
		if arg == flag && i+2 <= len(os.Args[1:]) {
			return os.Args[i+2]
		}
		if strings.HasPrefix(arg, flag+"=") {
			return strings.TrimPrefix(arg, flag+"=")
		}
	}
	return ""
}
