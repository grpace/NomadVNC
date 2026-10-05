//go:build !windows

package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "nomadvnc-host runs on 64-bit Windows.")
	os.Exit(1)
}
