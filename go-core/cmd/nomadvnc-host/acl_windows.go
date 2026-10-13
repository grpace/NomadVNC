package main

import (
	"io/fs"
	"os"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

// lockedDataSDDL gives the data folder to Administrators and lets only
// SYSTEM (the service) and Administrators (setup) in. P blocks the
// inherited ProgramData entries, which let every user read. The folder
// holds the VNC password and the Tailscale node key. The screen session
// never opens it: the service hands it the password and takes its log.
const lockedDataSDDL = "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"

// emptyACL is an access list with no entries: revision 2, 8 bytes long,
// zero entries. windows.ACLFromEntries can't make one; Windows hands it
// back a nil list for no entries and it crashes reading the size.
var emptyACL = [8]byte{2, 0, 8, 0, 0, 0, 0, 0}

// lockDataDir applies lockedDataSDDL to the data folder and makes
// everything in it inherit only from there. Older versions granted Users
// modify rights on the folder and its files; this removes them.
func lockDataDir() error {
	dir := dataDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString(lockedDataSDDL)
	if err != nil {
		return err
	}
	owner, _, err := sd.Owner()
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	if err := windows.SetNamedSecurityInfo(dir, windows.SE_FILE_OBJECT,
		windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		owner, nil, dacl, nil); err != nil {
		return err
	}
	// An empty explicit list plus "unprotected" leaves each entry with
	// only what it inherits from the folder.
	empty := (*windows.ACL)(unsafe.Pointer(&emptyACL[0]))
	return filepath.WalkDir(dir, func(path string, _ fs.DirEntry, err error) error {
		if err != nil || path == dir {
			return nil
		}
		if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT,
			windows.OWNER_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION|windows.UNPROTECTED_DACL_SECURITY_INFORMATION,
			owner, nil, empty, nil); err != nil {
			logf("lock %s: %v", path, err)
		}
		return nil
	})
}
