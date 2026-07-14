// Confinement tests for the os.Root-backed 9p attacher. These run on the dev host (darwin/linux) —
// os.Root is cross-platform, so the security property (a symlink out of the shared root cannot be
// walked, opened, created, or read through) is verified here even though the 9p mount itself only
// runs on Windows. This is the regression guard for the sandbox-escape the security review found.

package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/hugelgupf/p9/p9"
)

func attach(t *testing.T, dir string) p9.File {
	t.Helper()
	a, err := newConfinedAttacher(dir)
	if err != nil {
		t.Fatalf("newConfinedAttacher: %v", err)
	}
	// Release the os.Root handle before t.TempDir cleanup — on Windows an open dir handle blocks
	// RemoveAll of the shared dir.
	t.Cleanup(func() { _ = a.Close() })
	root, err := a.Attach()
	if err != nil {
		t.Fatalf("Attach: %v", err)
	}
	return root
}

// A symlink inside the share that points OUTSIDE it must not be openable through the 9p server —
// this is the exact escape (planted symlink/junction → arbitrary host read/write) being closed.
func TestConfinedOpenThroughEscapingSymlinkIsRejected(t *testing.T) {
	share := t.TempDir()
	outside := t.TempDir()
	secret := filepath.Join(outside, "secret")
	if err := os.WriteFile(secret, []byte("host-only"), 0o600); err != nil {
		t.Fatal(err)
	}
	// Plant an absolute symlink to the host secret inside the shared dir (as a mounted repo might).
	if err := os.Symlink(secret, filepath.Join(share, "escape")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	root := attach(t, share)
	_, walked, err := root.Walk([]string{"escape"})
	if err != nil {
		return // walk itself refused — also acceptable
	}
	if _, _, err := walked.Open(p9.ReadOnly); err == nil {
		t.Fatal("SECURITY: opened a file through a symlink escaping the shared root")
	}
}

// Walking through an escaping symlinked DIRECTORY to a file beyond it must also fail (the
// intermediate-component escape a naive QID-type check would miss).
func TestConfinedWalkThroughEscapingDirSymlinkIsRejected(t *testing.T) {
	share := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(share, "link")); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	root := attach(t, share)
	_, walked, err := root.Walk([]string{"link", "secret"})
	if err != nil {
		return // rejected at walk
	}
	if _, _, err := walked.Open(p9.ReadOnly); err == nil {
		t.Fatal("SECURITY: read a host file via an escaping directory symlink")
	}
}

// Creating a symlink with an absolute target is refused outright (belt: no host-resolvable trap).
func TestConfinedAbsoluteSymlinkCreateIsRejected(t *testing.T) {
	root := attach(t, t.TempDir())
	for _, target := range []string{"/etc/shadow", `\\host\share`, `C:\Windows\x`} {
		if _, err := root.Symlink(target, "evil", 0, 0); err == nil {
			t.Fatalf("SECURITY: created a symlink with an absolute target %q", target)
		}
	}
}

// A relative symlink that escapes via .. is allowed to be created (an in-root `../sibling` is legit),
// but os.Root must refuse to FOLLOW it out of the root at open time — the real guarantee.
func TestConfinedRelativeEscapeSymlinkUnopenable(t *testing.T) {
	share := t.TempDir()
	root := attach(t, share)
	if _, err := root.Symlink("../../../../etc/shadow", "evil", 0, 0); err != nil {
		return // rejected at creation is also fine
	}
	_, walked, err := root.Walk([]string{"evil"})
	if err != nil {
		return
	}
	if _, _, err := walked.Open(p9.ReadOnly); err == nil {
		t.Fatal("SECURITY: followed a ..-escaping relative symlink out of the root")
	}
}

// A normal file inside the share round-trips (the confinement doesn't break legitimate access).
func TestConfinedNormalFileRoundTrips(t *testing.T) {
	share := t.TempDir()
	if err := os.WriteFile(filepath.Join(share, "hello.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	root := attach(t, share)
	_, walked, err := root.Walk([]string{"hello.txt"})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	if _, _, err := walked.Open(p9.ReadOnly); err != nil {
		t.Fatalf("open in-root file: %v", err)
	}
	defer walked.Close() // release the file handle before Windows TempDir cleanup
	buf := make([]byte, 2)
	n, err := walked.ReadAt(buf, 0)
	if err != nil || string(buf[:n]) != "hi" {
		t.Fatalf("read got %q, %v", buf[:n], err)
	}
}

// .. and absolute names are rejected before touching the filesystem.
func TestConfinedRejectsUnsafeWalkNames(t *testing.T) {
	root := attach(t, t.TempDir())
	for _, name := range []string{"..", ".", "a/b", `a\b`, ""} {
		if _, _, err := root.Walk([]string{name}); err == nil {
			t.Fatalf("SECURITY: accepted unsafe walk name %q", name)
		}
	}
}
