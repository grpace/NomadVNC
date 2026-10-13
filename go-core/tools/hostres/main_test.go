package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/tc-hib/winres"
	"github.com/tc-hib/winres/version"
)

func TestResourcesCarryManifestAndVersion(t *testing.T) {
	rs, err := resources("1.2.3", "")
	if err != nil {
		t.Fatal(err)
	}
	manifest := string(rs.Get(winres.RT_MANIFEST, winres.ID(1), 0x409))
	for _, want := range []string{
		"Microsoft.Windows.Common-Controls", // themed controls
		">true</dpiAware>",                  // sharp on high-DPI screens
		`level="asInvoker"`,                 // elevation is asked for at run time
	} {
		if !strings.Contains(manifest, want) {
			t.Errorf("manifest lacks %q:\n%s", want, manifest)
		}
	}

	data := rs.Get(winres.RT_VERSION, winres.ID(1), 0x409)
	if data == nil {
		data = rs.Get(winres.RT_VERSION, winres.ID(1), 0)
	}
	vi, err := version.FromBytes(data)
	if err != nil {
		t.Fatal(err)
	}
	if got := vi.FileVersion; got != [4]uint16{1, 2, 3, 0} {
		t.Errorf("file version = %v", got)
	}
	table := vi.Table().GetMainTranslation()
	if table[version.ProductName] != "NomadVNC Host" || table[version.ProductVersion] != "1.2.3" {
		t.Errorf("version strings = %v", table)
	}

	// It links: the linker needs a COFF object for amd64.
	var obj bytes.Buffer
	if err := rs.WriteObject(&obj, winres.ArchAMD64); err != nil {
		t.Fatal(err)
	}
	if obj.Len() < 500 || obj.Bytes()[0] != 0x64 || obj.Bytes()[1] != 0x86 {
		t.Errorf("object is %d bytes, machine %#x%02x", obj.Len(), obj.Bytes()[1], obj.Bytes()[0])
	}
}

func TestMissingIconIsNotAnError(t *testing.T) {
	if _, err := resources("1.0.0", "/nonexistent/icon.ico"); err != nil {
		t.Fatal(err)
	}
}

func TestTrayIconReadsAtSixteenPixels(t *testing.T) {
	img := trayImage(16)
	at := func(x, y int) (r, g, b, a uint32) { return img.At(x, y).RGBA() }
	if _, _, _, a := at(0, 0); a != 0 {
		t.Error("the corner outside the shield should be clear")
	}
	if r, _, b, a := at(3, 3); a < 0xf000 || b < 0xf000 || r > 0x3000 {
		t.Errorf("the shield should be solid blue near its top, got r=%#x b=%#x a=%#x", r, b, a)
	}
	if r, g, _, _ := at(8, 5); r < 0xc000 || g < 0xc000 {
		t.Errorf("the head should be white, got r=%#x g=%#x", r, g)
	}
	rs, err := resources("1.0.0", "")
	if err != nil {
		t.Fatal(err)
	}
	if rs.Get(winres.RT_GROUP_ICON, winres.ID(TrayIconID), 0x409) == nil && rs.Get(winres.RT_GROUP_ICON, winres.ID(TrayIconID), 0) == nil {
		t.Error("the tray icon is missing from the resources")
	}
}
