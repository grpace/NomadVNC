package main

import (
	"context"
	"fmt"
	"os"

	"golang.org/x/sys/windows/svc"
)

func main() {
	isService, err := svc.IsWindowsService()
	logf("start service=%v elevated=%v privileged=%v err=%v", isService, isElevated(), isPrivileged(), err)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if isService {
		runWindowsService()
		return
	}
	if hasFlag("--session") {
		if err := runSession(context.Background()); err != nil {
			logf("session: %v", err)
			os.Exit(1)
		}
		return
	}
	if !isPrivileged() {
		logf("requesting administrator approval")
		if err := relaunchElevated(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if hasFlag("--install") {
		if name := flagValue("--name"); name != "" {
			if err := saveMachineName(name); err != nil {
				fmt.Fprintln(os.Stderr, err)
				os.Exit(1)
			}
		}
		password, err := passwordFromArgs(os.Args[1:])
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if err := installHost(password); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println("NomadVNC Host is installed and running.")
		return
	}
	if hasFlag("--uninstall") {
		if err := uninstallHost(hasFlag("--delete-data")); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println("NomadVNC Host was removed.")
		return
	}
	if hasFlag("--sign-in") {
		if err := signInTailscale(); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	runWizard()
}
