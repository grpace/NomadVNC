package main

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/nomadvnc/nomadvnc/go-core/internal/hostcore"
	"golang.org/x/sys/windows"
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
	args := strings.Join(os.Args[1:], " ")
	var argPtr *uint16
	if args != "" {
		argPtr, err = windows.UTF16PtrFromString(args)
		if err != nil {
			return err
		}
	}
	return windows.ShellExecute(0, verb, exePtr, argPtr, nil, windows.SW_SHOWNORMAL)
}

func installHost(password string) error {
	if err := hostcore.ValidatePassword(password); err != nil {
		return err
	}
	if !isPrivileged() {
		return errors.New("administrator approval is required")
	}
	if err := os.MkdirAll(dataDir(), 0o755); err != nil {
		return err
	}
	shareDataWithUsers()
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	dest := installedExe()
	stopService()
	if !sameFile(exe, dest) {
		if err := copyExecutable(exe, dest); err != nil {
			return err
		}
	}
	if err := writePassword(password); err != nil {
		return err
	}
	if err := preferPrivateNetwork(); err != nil {
		logf("network profile: %v", err)
	}
	if err := installFirewall(); err != nil {
		return err
	}
	if err := installService(dest); err != nil {
		return err
	}
	if err := installShortcut(dest); err != nil {
		logf("start menu shortcut: %v", err)
	}
	return startService()
}

func uninstallHost(deleteData bool) error {
	if !isPrivileged() {
		return errors.New("administrator approval is required")
	}
	stopService()
	_ = exec.Command("sc.exe", "delete", hostcore.ServiceName).Run()
	_ = exec.Command("netsh", "advfirewall", "firewall", "delete", "rule", "name="+hostcore.FirewallRule).Run()
	_ = os.Remove(shortcutPath())
	// The setup window may be this exe, so deleting the folder can fail
	// until that window closes. A stopped service no longer locks it.
	if running, err := os.Executable(); err == nil && !sameFile(running, installedExe()) {
		_ = os.RemoveAll(hostcore.InstallDir(os.Getenv("ProgramFiles")))
	}
	if deleteData {
		_ = os.RemoveAll(dataDir())
	}
	return nil
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
	_ = os.Remove(dest)
	if err := os.Rename(tmp, dest); err != nil {
		return err
	}
	return nil
}

func shareDataWithUsers() {
	// The service runs as LocalSystem and the screen session runs as the
	// signed-in user. Both need to read the password and append the log.
	dir := dataDir()
	out, err := exec.Command("icacls", dir, "/grant", "*S-1-5-32-545:(OI)(CI)M").CombinedOutput()
	if err != nil {
		logf("data folder permissions: %v: %s", err, bytesTrim(out))
	}
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

func installFirewall() error {
	_ = exec.Command("netsh", "advfirewall", "firewall", "delete", "rule", "name="+hostcore.FirewallRule).Run()
	out, err := exec.Command(
		"netsh", "advfirewall", "firewall", "add", "rule",
		"name="+hostcore.FirewallRule,
		"dir=in",
		"action=allow",
		"protocol=TCP",
		"localport=5900",
		"profile=private,domain",
	).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s: %s", err, bytesTrim(out))
	}
	return nil
}

func installService(exe string) error {
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
