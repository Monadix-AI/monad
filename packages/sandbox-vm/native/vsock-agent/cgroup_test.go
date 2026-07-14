package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestRunCgroupNameRejectsPathTraversal(t *testing.T) {
	for _, id := range []string{"../escape", "a/b", "", "run id"} {
		if _, err := runCgroupName(id); err == nil {
			t.Fatalf("expected %q to be rejected", id)
		}
	}
	name, err := runCgroupName("run-safe_1")
	if err != nil || name != "run-run-safe_1" {
		t.Fatalf("unexpected safe name %q, %v", name, err)
	}
}

func TestWriteRunCgroupAppliesLimitsBeforePid(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"memory.max", "pids.max", "cgroup.procs"} {
		if err := os.WriteFile(filepath.Join(dir, name), nil, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := writeRunCgroup(dir, runLimits{MemoryMiB: 128, MaxProcesses: 32}, 456); err != nil {
		t.Fatal(err)
	}
	expectFile(t, filepath.Join(dir, "memory.max"), "134217728")
	expectFile(t, filepath.Join(dir, "pids.max"), "32")
	expectFile(t, filepath.Join(dir, "cgroup.procs"), "456")
}

func TestUnifiedCgroupPathSelectsV2Hierarchy(t *testing.T) {
	got, err := unifiedCgroupPath("7:cpu:/legacy\n0::/system.slice/monad.service/broker\n")
	if err != nil || got != "/system.slice/monad.service/broker" {
		t.Fatalf("got %q, %v", got, err)
	}
}

func expectFile(t *testing.T, path string, want string) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != want {
		t.Fatalf("%s: got %q, want %q", path, got, want)
	}
}
