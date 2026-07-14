//go:build linux

package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
)

func TestDrainObservationRecordsClassifiesBoundsAndCoalesces(t *testing.T) {
	var output bytes.Buffer
	reporter := &supervisorReporter{encoder: json.NewEncoder(&output)}
	input := strings.Join([]string{
		`{"syscall":"openat","pid":7,"path":"/work/allowed"}`,
		`{"syscall":"openat","pid":8,"path":"/etc/denied"}`,
		`{"syscall":"openat","pid":9,"path":"/etc/denied"}`,
		`not-json`,
		`{"syscall":"unknown","pid":10,"path":"/etc/unknown"}`,
		`{"syscall":"openat","pid":11,"path":"/` + strings.Repeat("a", 4097) + `"}`,
		`{"error":"unsupported"}`,
	}, "\n") + "\n"

	drainObservationRecords(strings.NewReader(input), observationPolicy{WritableRoots: []string{"/work"}}, "run-observe", reporter)

	decoder := json.NewDecoder(&output)
	var records []supervisorRecord
	for decoder.More() {
		var record supervisorRecord
		if err := decoder.Decode(&record); err != nil {
			t.Fatal(err)
		}
		records = append(records, record)
	}
	if len(records) != 2 {
		t.Fatalf("records = %+v", records)
	}
	filesystem := records[0].Violation
	if filesystem == nil || filesystem.Kind != "filesystem" || filesystem.Operation != "openat" || filesystem.Target != "/etc/denied" || filesystem.PID != 8 {
		t.Fatalf("filesystem record = %+v", filesystem)
	}
	setup := records[1].Violation
	if setup == nil || setup.Kind != "setup" || setup.Operation != "seccomp-observer" || setup.Detail != "seccomp observer unsupported" {
		t.Fatalf("setup record = %+v", setup)
	}
}

func TestPrepareObservedCommandPreservesWorkloadContract(t *testing.T) {
	directory := t.TempDir()
	helper := directory + "/observer"
	if err := os.WriteFile(helper, []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	originalPath := seccompObserverPath
	seccompObserverPath = helper
	t.Cleanup(func() { seccompObserverPath = originalPath })

	original := exec.Command("/bin/echo", "hello")
	original.Dir = "/tmp"
	original.Env = []string{"A=B"}
	original.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: 12, Gid: 34}}
	var output bytes.Buffer
	reporter := &supervisorReporter{encoder: json.NewEncoder(&output)}

	wrapped, eventReader, eventWriter := prepareObservedCommand(original, "run-wrap", reporter)
	defer eventReader.Close()
	defer eventWriter.Close()
	if wrapped.Path != helper || wrapped.Dir != original.Dir || wrapped.Env[0] != "A=B" || wrapped.SysProcAttr != original.SysProcAttr {
		t.Fatalf("wrapped command lost contract: %+v", wrapped)
	}
	wantArgs := []string{helper, "--event-fd", "3", "--", "/bin/echo", "hello"}
	if strings.Join(wrapped.Args, "\x00") != strings.Join(wantArgs, "\x00") || len(wrapped.ExtraFiles) != 1 {
		t.Fatalf("wrapped args/files = %q / %d", wrapped.Args, len(wrapped.ExtraFiles))
	}
}

func TestPrepareObservedCommandFallsBackWhenHelperIsMissing(t *testing.T) {
	originalPath := seccompObserverPath
	seccompObserverPath = t.TempDir() + "/missing"
	t.Cleanup(func() { seccompObserverPath = originalPath })
	original := exec.Command("/bin/true")
	var output bytes.Buffer
	reporter := &supervisorReporter{encoder: json.NewEncoder(&output)}

	prepared, eventReader, eventWriter := prepareObservedCommand(original, "run-missing", reporter)
	if prepared != original || eventReader != nil || eventWriter != nil {
		t.Fatalf("missing helper did not preserve workload")
	}
	var record supervisorRecord
	if err := json.NewDecoder(&output).Decode(&record); err != nil {
		t.Fatal(err)
	}
	if record.Violation == nil || record.Violation.Kind != "setup" || record.Violation.Operation != "seccomp-observer" {
		t.Fatalf("fallback record = %+v", record)
	}
}
