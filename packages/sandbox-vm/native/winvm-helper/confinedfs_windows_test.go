//go:build windows

// Windows-specific confinement test. On Windows the no-privilege escape vector is a directory
// JUNCTION (`mklink /J`, unlike symlinks which need SeCreateSymbolicLinkPrivilege). A junction inside
// a shared root pointing outside it must not let the guest read host files — os.Root refuses to
// traverse reparse points that escape the root. This runs on the real Windows backend.

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func mklinkJunction(t *testing.T, link, target string) {
	t.Helper()
	// /J = directory junction, creatable by an unprivileged user.
	out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput()
	if err != nil {
		t.Skipf("mklink /J unavailable: %v (%s)", err, out)
	}
}

func TestConfinedRejectsJunctionEscape(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("HOST DATA"), 0o644); err != nil {
		t.Fatal(err)
	}
	mklinkJunction(t, filepath.Join(root, "j"), outside)

	a, err := newConfinedAttacher(root)
	if err != nil {
		t.Fatalf("newConfinedAttacher: %v", err)
	}
	t.Cleanup(func() { _ = a.Close() })
	f, err := a.Attach()
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	// Walking through the junction to the outside file must fail at the os.Root boundary; a success
	// here is a guest→host filesystem escape.
	if _, _, err := f.Walk([]string{"j", "secret"}); err == nil {
		t.Fatal("SECURITY: walked through a directory junction escaping the shared root")
	}
}
