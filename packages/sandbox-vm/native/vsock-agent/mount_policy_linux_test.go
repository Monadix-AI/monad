//go:build linux

package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestEnsureFileAcceptsExistingReadOnlyRegularFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "target")
	if err := os.WriteFile(path, []byte("value"), 0o400); err != nil {
		t.Fatal(err)
	}
	if err := ensureFile(path); err != nil {
		t.Fatal(err)
	}
}

func TestEnsureFileRejectsSymlink(t *testing.T) {
	dir := t.TempDir()
	real := filepath.Join(dir, "real")
	alias := filepath.Join(dir, "alias")
	if err := os.WriteFile(real, []byte("value"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, alias); err != nil {
		t.Fatal(err)
	}
	if err := ensureFile(alias); err == nil {
		t.Fatal("symlink target was accepted")
	}
}
