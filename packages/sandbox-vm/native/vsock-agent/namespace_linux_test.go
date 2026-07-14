//go:build linux

package main

import (
	"fmt"
	"os"
	"testing"
)

func TestIsolateRunFilesystemsRemountsProcForTheRunPidNamespace(t *testing.T) {
	var operations []string
	mount := func(source, target, filesystem string, flags uintptr, data string) error {
		operations = append(operations, fmt.Sprintf("mount:%s:%s:%s:%d:%s", source, target, filesystem, flags, data))
		return nil
	}
	mkdir := func(path string, mode os.FileMode) error {
		operations = append(operations, fmt.Sprintf("mkdir:%s:%o", path, mode))
		return nil
	}

	if err := isolateRunFilesystems(mount, mkdir); err != nil {
		t.Fatal(err)
	}
	if len(operations) != 4 {
		t.Fatalf("operations = %q", operations)
	}
	if operations[0] != "mount::/::278528:" {
		t.Fatalf("private root mount = %q", operations[0])
	}
	if operations[1] != "mount:proc:/proc:proc:14:" {
		t.Fatalf("run proc mount = %q", operations[1])
	}
	if operations[2] != "mkdir:/tmp:1777" || operations[3] != "mount:tmpfs:/tmp:tmpfs:6:mode=1777,size=256m" {
		t.Fatalf("private tmp operations = %q", operations[2:])
	}
}
