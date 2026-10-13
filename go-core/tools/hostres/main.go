// Command hostres writes the Windows resources linked into NomadVNC Host:
// its manifest, its version details and its icon. scripts/build-host.mjs
// runs it before building the exe; the Go linker picks up the .syso file
// it leaves in the package directory.
package main

import (
	"flag"
	"fmt"
	"image/png"
	"os"

	"github.com/tc-hib/winres"
	"github.com/tc-hib/winres/version"
)

func main() {
	ver := flag.String("version", "0.0.0", "product version, as in package.json")
	iconPath := flag.String("icon", "", ".ico file for the exe; none if empty or missing")
	out := flag.String("out", "", "path of the .syso file to write")
	preview := flag.String("tray-preview", "", "write the tray icon as a PNG here and stop")
	flag.Parse()
	if *preview != "" {
		f, err := os.Create(*preview)
		if err == nil {
			err = png.Encode(f, trayImage(256))
			f.Close()
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, "hostres:", err)
			os.Exit(1)
		}
		return
	}
	if *out == "" {
		fmt.Fprintln(os.Stderr, "hostres: -out is required")
		os.Exit(2)
	}
	if err := write(*out, *ver, *iconPath); err != nil {
		fmt.Fprintln(os.Stderr, "hostres:", err)
		os.Exit(1)
	}
}

func write(out, ver, iconPath string) error {
	rs, err := resources(ver, iconPath)
	if err != nil {
		return err
	}
	f, err := os.Create(out)
	if err != nil {
		return err
	}
	if err := rs.WriteObject(f, winres.ArchAMD64); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}

// IconID is the resource ID of the exe's icon. The setup window loads it
// by this number.
const IconID = 1

func resources(ver, iconPath string) (*winres.ResourceSet, error) {
	rs := &winres.ResourceSet{}

	// Without a manifest Windows draws the setup window with pre-XP
	// controls and scales it as a blurry bitmap on high-DPI screens. DPI
	// awareness is the system kind, the same the exe used to switch on at
	// run time, so screen capture sees real pixels as before. The exe asks
	// for elevation itself, when a step needs it.
	rs.SetManifest(winres.AppManifest{
		Identity:            winres.AssemblyIdentity{Name: "NomadVNC.Host"},
		Description:         "NomadVNC Host",
		Compatibility:       winres.Win10AndAbove,
		ExecutionLevel:      winres.AsInvoker,
		DPIAwareness:        winres.DPIAware,
		UseCommonControlsV6: true,
	})

	var vi version.Info
	vi.SetFileVersion(ver)
	vi.SetProductVersion(ver)
	for key, value := range map[string]string{
		version.ProductName:      "NomadVNC Host",
		version.FileDescription:  "NomadVNC Host",
		version.CompanyName:      "Greg Pace",
		version.LegalCopyright:   "Copyright © 2026 Greg Pace",
		version.OriginalFilename: "nomadvnc-host.exe",
		version.InternalName:     "nomadvnc-host",
	} {
		if err := vi.Set(version.LangDefault, key, value); err != nil {
			return nil, err
		}
	}
	rs.SetVersionInfo(vi)

	if iconPath != "" {
		f, err := os.Open(iconPath)
		switch {
		case os.IsNotExist(err):
			// Icons are rendered by `pnpm icons`; a build without them
			// still works, with the plain Windows program icon.
			fmt.Fprintf(os.Stderr, "hostres: no icon at %s; building without one\n", iconPath)
		case err != nil:
			return nil, err
		default:
			defer f.Close()
			icon, err := winres.LoadICO(f)
			if err != nil {
				return nil, fmt.Errorf("%s: %w", iconPath, err)
			}
			if err := rs.SetIcon(winres.ID(IconID), icon); err != nil {
				return nil, err
			}
		}
	}
	tray, err := trayIcon()
	if err != nil {
		return nil, err
	}
	if err := rs.SetIcon(winres.ID(TrayIconID), tray); err != nil {
		return nil, err
	}
	return rs, nil
}
